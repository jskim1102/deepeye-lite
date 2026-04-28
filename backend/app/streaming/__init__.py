"""영상 캡처 + 추론 통합 스트리밍 패키지.

웹캠(V4L2 int index) 과 IP CAM(RTSP URL) 을 동일한 인터페이스로 처리하고,
모든 소스가 단일 `InferenceWorker` 를 공유한다.
"""

from app.streaming.capture import VideoCaptureThread
from app.streaming.manager import StreamManager, manager

__all__ = ["VideoCaptureThread", "StreamManager", "manager"]
