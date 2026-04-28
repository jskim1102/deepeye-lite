# syntax=docker/dockerfile:1.7
# DeepEye Lite Backend — FastAPI + OpenCV + YOLO 추론 (v3.0~)
# 베이스: python:3.11-slim (Debian slim), Linux 전용
# 의존성 관리: pip + requirements.txt (CLAUDE.md §9 — Docker 이미지에는 Poetry 불포함)
#
# v2.x → v3.0 변경:
#   - requirements.txt 가 ultralytics + torch + CUDA 휠 포함 → 이미지 ~3GB
#   - GPU/CPU 듀얼 지원 (DEV_SPEC v3.0 §2.8)
#     * Linux + NVIDIA + Toolkit + `--gpus all` → CUDA 가속
#     * Mac/Windows/Linux GPU 없음 → CPU 폴백 (자동)
#   - YOLO 가중치 캐시 디렉토리 사전 생성 (compose.gpu.yml 의 yolo_weights 볼륨 마운트 대상)

FROM python:3.11-slim

# -----------------------------------------------------------------------------
# 시스템 패키지
#   - libglib2.0-0     : opencv-python-headless 런타임 의존 (GLib)
#   - libgomp1         : torch / ultralytics 런타임 의존 (OpenMP)
#   - usbutils         : webcam.py 가 `lsusb` 로 USB 웹캠 제품명 조회
# -----------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgomp1 \
        usbutils \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# -----------------------------------------------------------------------------
# 의존성 설치 (레이어 캐시 극대화)
#   requirements.txt 는 호스트에서 `poetry export` 로 생성된 파일.
#   v3.0 에서 ultralytics 추가로 torch + NVIDIA CUDA 휠이 함께 설치됨.
#   CUDA 휠은 Linux x86_64 환경 마커가 붙어있어 다른 OS/아키텍처에선 자동 스킵.
#
# opencv 처리:
#   ultralytics 가 `opencv-python` (X11 의존) 을 함께 끌어오는데, 우리는
#   `opencv-python-headless` 를 명시했으므로 둘 다 설치됨. 설치 순서상
#   opencv-python 이 마지막에 같은 cv2 디렉토리를 덮어 X11 라이브러리(libxcb 등)
#   를 요구하게 됨 → headless 이미지에서 ImportError. 강제 재설치로 headless
#   파일만 남도록 정리.
# -----------------------------------------------------------------------------
COPY requirements.txt ./
RUN pip install -r requirements.txt \
    && pip uninstall -y opencv-python \
    && pip install --no-deps --force-reinstall opencv-python-headless==4.13.0.92

# -----------------------------------------------------------------------------
# YOLO 가중치 캐시 디렉토리 사전 생성
#   ultralytics 가 모델을 처음 사용할 때 ~/.cache/ultralytics 에 다운로드.
#   docker-compose.gpu.yml 의 yolo_weights named volume 이 여기에 마운트되어 영속화.
#   디렉토리가 없으면 ultralytics 가 자동 생성하지만, 사전 생성하여 권한 문제 회피.
# -----------------------------------------------------------------------------
RUN mkdir -p /root/.cache/ultralytics

# 애플리케이션 소스
COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
