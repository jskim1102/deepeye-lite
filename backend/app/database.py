from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# DB 파일은 backend/ 디렉토리에 저장
_db_path = Path(__file__).resolve().parent.parent / "deepeye.db"
DATABASE_URL = f"sqlite:///{_db_path}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine)


class Base(DeclarativeBase):
    pass


def init_db() -> None:
    """모든 테이블 생성 (없는 경우에만)"""
    Base.metadata.create_all(bind=engine)


def get_db():
    """FastAPI Depends용 DB 세션 제너레이터"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
