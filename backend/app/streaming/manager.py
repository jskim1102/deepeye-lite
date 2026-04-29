"""모든 영상 소스 + 단일 InferenceWorker 의 통합 매니저.

- 캡처 스레드들이 모두 같은 worker 에 frame 제출
- worker 결과는 dispatch 스레드가 source_id 별로 캐싱
- 캡처 스레드는 캐시에서 자기 source_id 의 최신 결과만 조회
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import defaultdict, deque
from typing import Optional, Union

import numpy as np

from app.inference import FrameRequest, InferenceResult, InferenceWorker
from app.streaming.capture import SourceType, VideoCaptureThread

logger = logging.getLogger("deepeye.streaming.manager")


class StreamManager:
    """비디오 소스(웹캠/IP CAM) + 추론 워커 통합 관리.

    싱글톤으로 사용 (`from app.streaming import manager`).
    서버 lifespan 시작/종료에서 `startup()` / `shutdown()` 호출.
    """

    # dispatch 루프의 idle sleep
    _DISPATCH_IDLE_SEC = 0.01

    # 추론 fps 측정 슬라이딩 윈도우
    _INFERENCE_FPS_WINDOW_SEC = 5.0
    _INFERENCE_FPS_DEQUE_MAXLEN = 600

    def __init__(self, jpeg_quality: int = 70, inference_interval: float = 0.1) -> None:
        self._captures: dict[str, VideoCaptureThread] = {}
        self._lock = threading.Lock()
        self._jpeg_quality = jpeg_quality
        # 추론 FPS 제한 — 매 프레임 추론은 GPU 낭비. 기본 10fps (interval 0.1s).
        self._inference_interval = inference_interval

        self._worker = InferenceWorker()
        self._latest_results: dict[str, InferenceResult] = {}
        self._results_lock = threading.Lock()

        # source_id 별 추론 완료 timestamp (5초 윈도우)
        self._inference_ts: dict[str, deque[float]] = defaultdict(
            lambda: deque(maxlen=self._INFERENCE_FPS_DEQUE_MAXLEN)
        )
        self._inference_ts_lock = threading.Lock()

        # source_id 별 추론 enabled — key 없으면 True 가 기본
        self._per_source_enabled: dict[str, bool] = {}
        # source_id 별 confidence threshold — key 없으면 worker 의 global 값 사용
        self._per_source_conf: dict[str, float] = {}
        # source_id 별 사용 모델 목록.
        #   key 없음 → global 기본 모델 1개 사용
        #   [] (빈 리스트) → 이 카메라 추론 안 함 (bbox 없음)
        #   [m1, m2, ...] → 해당 모델들 사용 (Phase 1 에선 첫 항목만, Phase 2 에 다중 적용 예정)
        self._per_source_models: dict[str, list[str]] = {}
        self._per_source_lock = threading.Lock()

        self._dispatch_thread: Optional[threading.Thread] = None
        self._dispatch_running = False

    # ── lifecycle ────────────────────────────────────────────────

    def startup(self) -> None:
        """워커 + dispatch 스레드 기동."""
        self._worker.start()
        self._dispatch_running = True
        self._dispatch_thread = threading.Thread(
            target=self._dispatch_loop, daemon=True, name="inference-dispatch"
        )
        self._dispatch_thread.start()
        logger.info("StreamManager started (inference worker + dispatch)")

    def shutdown(self) -> None:
        """모든 캡처 + 워커 + dispatch 정리."""
        # 1) 캡처 강제 종료
        with self._lock:
            captures = list(self._captures.values())
            self._captures.clear()
        for cap in captures:
            cap.force_stop()
            logger.info("Capture %s 강제 종료", cap.source_id)

        # 2) dispatch 종료
        self._dispatch_running = False
        if self._dispatch_thread:
            self._dispatch_thread.join(timeout=2)

        # 3) worker 종료
        self._worker.stop()
        logger.info("StreamManager shutdown 완료")

    # ── 캡처 시작/종료 (라우터에서 호출) ─────────────────────────

    def start_capture(self, source_id: str, source: SourceType) -> bool:
        """source_id 의 캡처 시작 (없으면 생성). ref_count 증가."""
        with self._lock:
            if source_id not in self._captures:
                self._captures[source_id] = VideoCaptureThread(
                    source_id=source_id,
                    source=source,
                    frame_callback=self._submit_frame,
                    # result_provider 는 §4.19 옵션 2 로 제거됨 (frontend overlay)
                    jpeg_quality=self._jpeg_quality,
                    inference_interval=self._inference_interval,
                )
        return self._captures[source_id].start()

    def stop_capture(self, source_id: str) -> None:
        with self._lock:
            cap = self._captures.get(source_id)
        if cap:
            cap.stop()

    def get_frame(self, source_id: str) -> bytes:
        with self._lock:
            cap = self._captures.get(source_id)
        if cap:
            return cap.get_frame()
        return b""

    def get_capture_stats(self, source_id: str) -> Optional[dict]:
        """캡처 중인 source 의 source_fps + inference_fps. 캡처 미동작이면 None.

        - source_fps: RTSP 가 실제로 보내는 frame 속도 (cap.read 성공률)
        - inference_fps: YOLO 가 그 source 에 대해 실제 추론 완료한 속도
                         (INFERENCE_FPS 환경변수가 상한, GPU 부하 시 더 낮아짐)
        """
        with self._lock:
            cap = self._captures.get(source_id)
        if not cap or not cap.is_running:
            return None

        # inference_fps — 최근 5초 윈도우
        now = time.time()
        cutoff = now - self._INFERENCE_FPS_WINDOW_SEC
        with self._inference_ts_lock:
            ts = self._inference_ts.get(source_id, ())
            n = sum(1 for t in ts if t >= cutoff)
        inference_fps = round(n / self._INFERENCE_FPS_WINDOW_SEC, 1)

        return {
            "source_fps": cap.get_source_fps(),
            "inference_fps": inference_fps,
        }

    # ── 캡처 ↔ 워커 bridge ───────────────────────────────────────

    def _submit_frame(self, source_id: str, frame: np.ndarray) -> None:
        """캡처 스레드 callback — global AND per-source 둘 다 ON 인 경우만 워커에 제출.

        per-source conf 가 설정돼 있으면 FrameRequest 에 포함 → 워커가 그 값으로 추론.
        없으면 None 이라 워커가 global 값 사용.
        """
        status = self._worker.get_status()
        if not status.get("enabled", True):
            return
        if not self.is_source_inference_enabled(source_id):
            return
        with self._per_source_lock:
            conf = self._per_source_conf.get(source_id)
            models_list = self._per_source_models.get(source_id)  # None or list

        # 빈 리스트 = 명시적 "추론 안 함"
        if models_list is not None and len(models_list) == 0:
            return

        # Phase 2: 모델 list 전체를 worker 에 전달 → 다중 모델 detection 합침
        self._worker.submit(
            FrameRequest(
                source_id=source_id,
                frame=frame,
                timestamp=time.time(),
                conf_threshold=conf,
                model_names=models_list,  # None or non-empty list
            )
        )

    def _get_latest_result(self, source_id: str) -> Optional[InferenceResult]:
        """source_id 의 최신 추론 결과 (없으면 None)."""
        with self._results_lock:
            return self._latest_results.get(source_id)

    # WS 핸들러용 public alias — frontend overlay 가 detections JSON 으로 받음 (§4.19)
    def get_source_latest_detections(self, source_id: str) -> Optional[InferenceResult]:
        return self._get_latest_result(source_id)

    def _dispatch_loop(self) -> None:
        """worker.out_q → _latest_results 캐시 + 추론 fps 측정. 별도 스레드."""
        while self._dispatch_running:
            results = self._worker.drain_results()
            if results:
                now = time.time()
                with self._results_lock:
                    for r in results:
                        self._latest_results[r.source_id] = r
                # 추론 fps 측정 — source_id 별로 timestamp 기록
                with self._inference_ts_lock:
                    for r in results:
                        self._inference_ts[r.source_id].append(now)
            else:
                time.sleep(self._DISPATCH_IDLE_SEC)
        logger.info("Dispatch loop 종료")

    # ── 추론 제어 (FastAPI 라우터에서 호출) ──────────────────────

    def get_inference_config(self) -> dict:
        return self._worker.get_status()

    def set_inference_enabled(self, enabled: bool) -> None:
        self._worker.set_enabled(enabled)
        if not enabled:
            # OFF 시 캐시 비워서 raw 프레임으로 회귀
            with self._results_lock:
                self._latest_results.clear()

    def set_inference_model(self, model_name: str) -> None:
        self._worker.set_model(model_name)

    def set_inference_conf_threshold(self, threshold: float) -> None:
        self._worker.set_conf_threshold(threshold)

    # ── per-source 추론 ON/OFF (각 카메라마다 독립적으로 제어) ──

    def is_source_inference_enabled(self, source_id: str) -> bool:
        """key 없으면 True (기본 ON)."""
        with self._per_source_lock:
            return self._per_source_enabled.get(source_id, True)

    def set_source_inference_enabled(self, source_id: str, enabled: bool) -> None:
        """source_id 의 추론 ON/OFF. OFF 시 기존 결과 캐시 비워서 bbox 즉시 사라지게."""
        with self._per_source_lock:
            self._per_source_enabled[source_id] = enabled
        if not enabled:
            with self._results_lock:
                self._latest_results.pop(source_id, None)
        logger.info("Per-source inference: %s = %s", source_id, enabled)

    def get_source_conf_threshold(self, source_id: str) -> Optional[float]:
        """source_id 의 per-source conf. 없으면 None (= global 사용)."""
        with self._per_source_lock:
            return self._per_source_conf.get(source_id)

    def set_source_conf_threshold(self, source_id: str, conf: float) -> None:
        """source_id 의 per-source conf 설정 (0~1)."""
        conf = max(0.0, min(1.0, float(conf)))
        with self._per_source_lock:
            self._per_source_conf[source_id] = conf
        logger.info("Per-source conf: %s = %.2f", source_id, conf)

    def get_source_models(self, source_id: str) -> Optional[list[str]]:
        """source_id 의 per-source 모델 목록.

        - None: 미설정 (global 기본 1개 사용)
        - []  : 명시적 추론 안 함
        - [m1, m2, ...]: 해당 모델들 (Phase 1 에선 [0] 만 적용)
        """
        with self._per_source_lock:
            models = self._per_source_models.get(source_id)
            return list(models) if models is not None else None  # 복사 반환

    def set_source_models(self, source_id: str, models: list[str]) -> None:
        """source_id 의 per-source 모델 목록 설정. 빈 리스트면 추론 안 함."""
        with self._per_source_lock:
            self._per_source_models[source_id] = list(models)
        logger.info("Per-source models: %s = %s", source_id, models)


def detections_to_json(result: InferenceResult) -> str:
    """InferenceResult → WS 로 보낼 JSON 문자열. frontend overlay 가 파싱.

    좌표 xyxy 는 raw frame 픽셀 기준 (frontend 가 displayed canvas 로 스케일링).
    """
    return json.dumps({
        "type": "detections",
        "timestamp": result.timestamp,
        "items": [
            {
                "class_id": d.class_id,
                "name": d.class_name,
                "conf": d.confidence,
                "xyxy": list(d.xyxy),
                "model": d.model,
            }
            for d in result.detections
        ],
    }, ensure_ascii=False)


# 싱글톤 — main.py 에서 startup/shutdown 호출
manager = StreamManager()
