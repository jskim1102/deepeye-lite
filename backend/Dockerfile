# syntax=docker/dockerfile:1.7
# DeepEye Lite Backend — FastAPI + OpenCV
# 베이스: python:3.11-slim (Debian slim), Linux 전용 (v2.0 방침)
# 의존성 관리: pip + requirements.txt (CLAUDE.md §9 — Docker 이미지에는 Poetry 불포함)

FROM python:3.11-slim

# -----------------------------------------------------------------------------
# 시스템 패키지
#   - libglib2.0-0  : opencv-python-headless 런타임 의존 (GLib)
#   - usbutils      : webcam.py 가 `lsusb` 로 USB 웹캠 제품명 조회
# -----------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
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
#   애플리케이션 소스 변경 시 이 레이어가 캐시로 재사용되어 재빌드 시간 단축.
# -----------------------------------------------------------------------------
COPY requirements.txt ./
RUN pip install -r requirements.txt

# 애플리케이션 소스
COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
