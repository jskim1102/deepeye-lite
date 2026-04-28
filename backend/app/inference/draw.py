"""bbox + 라벨 시각화 (OpenCV 기반).

캡처 thread 가 매 프레임마다 호출 — 워커의 최신 InferenceResult.detections 를 frame 위에 그린다.
"""

from __future__ import annotations

from typing import Sequence

import cv2
import numpy as np

from app.inference.worker import Detection


# 클래스 ID → BGR 색상 (ultralytics 의 Colors 와 유사한 팔레트, 시각적 구분 잘 됨)
_PALETTE_BGR: tuple[tuple[int, int, int], ...] = (
    (56, 56, 255),      # red
    (151, 157, 255),    # pink
    (31, 112, 255),     # orange
    (29, 178, 255),     # yellow-orange
    (49, 210, 207),     # cyan
    (10, 249, 72),      # green
    (23, 204, 146),     # teal
    (134, 219, 61),     # lime
    (52, 147, 26),      # dark green
    (187, 212, 0),      # turquoise
    (168, 153, 44),     # olive
    (255, 194, 0),      # blue
    (255, 56, 132),     # purple
    (133, 56, 255),     # violet
    (255, 149, 200),    # magenta
    (255, 55, 199),     # pink
)


def color_for_class(class_id: int) -> tuple[int, int, int]:
    """class_id 로 색상 결정 (BGR). 동일 class 는 항상 동일 색."""
    return _PALETTE_BGR[class_id % len(_PALETTE_BGR)]


def draw_bboxes(
    frame: np.ndarray,
    detections: Sequence[Detection],
    *,
    line_thickness: int = 2,
    font_scale: float = 0.5,
) -> np.ndarray:
    """frame 에 bbox 와 라벨 텍스트를 그린다 (in-place 수정 + 동일 객체 반환).

    각 detection 마다:
        - 사각형 (class 별 색)
        - 라벨 박스 (좌상단)  e.g. "person 0.87"
    """
    for det in detections:
        x1, y1, x2, y2 = det.xyxy
        color = color_for_class(det.class_id)

        # 1) 사각형
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, line_thickness, lineType=cv2.LINE_AA)

        # 2) 라벨 + 배경
        label = f"{det.class_name} {det.confidence:.2f}"
        (lw, lh), baseline = cv2.getTextSize(
            label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, 1
        )
        # 배경 박스 (위에 띄움 — 음수 y 가 나오면 박스 안쪽에)
        bg_y1 = max(0, y1 - lh - baseline - 4)
        bg_y2 = y1
        cv2.rectangle(
            frame, (x1, bg_y1), (x1 + lw + 6, bg_y2), color, thickness=cv2.FILLED
        )
        cv2.putText(
            frame,
            label,
            (x1 + 3, bg_y2 - baseline - 2),
            cv2.FONT_HERSHEY_SIMPLEX,
            font_scale,
            (255, 255, 255),
            thickness=1,
            lineType=cv2.LINE_AA,
        )
    return frame
