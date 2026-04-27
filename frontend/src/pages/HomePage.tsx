import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

function HomePage() {
  const navigate = useNavigate();
  const [backendStatus, setBackendStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    const apiPort = import.meta.env.VITE_API_PORT;
    fetch(`http://${window.location.hostname}:${apiPort}/api/health`)
      .then((res) => res.json())
      .then((data) => {
        if (data.status === "ok") setBackendStatus("ok");
        else setBackendStatus("error");
      })
      .catch(() => setBackendStatus("error"));
  }, []);

  const statusText = {
    loading: "백엔드 연결 확인 중...",
    ok: "백엔드 연결됨",
    error: "백엔드 연결 실패",
  };

  const statusColor = {
    loading: "#aaaaaa",
    ok: "#4caf50",
    error: "#f44336",
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>DeepEye Lite</h1>
      <p style={styles.subtitle}>CCTV AI 분석 플랫폼</p>
      <div style={styles.buttonGroup}>
        <button style={styles.button} onClick={() => navigate("/webcam")}>
          Webcam
        </button>
        <button style={styles.button} onClick={() => navigate("/ipcam")}>
          IP CAM
        </button>
      </div>
      <p style={{ ...styles.status, color: statusColor[backendStatus] }}>
        {statusText[backendStatus]}
      </p>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    backgroundColor: "#1a1a2e",
    color: "#ffffff",
  },
  title: {
    fontSize: "2.5rem",
    marginBottom: "0.5rem",
  },
  subtitle: {
    fontSize: "1rem",
    color: "#aaaaaa",
    marginBottom: "3rem",
  },
  buttonGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    width: "280px",
  },
  button: {
    padding: "1rem 2rem",
    fontSize: "1.2rem",
    borderRadius: "8px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#16213e",
    color: "#ffffff",
    transition: "background-color 0.2s",
  },
  status: {
    marginTop: "2rem",
    fontSize: "0.9rem",
  },
};

export default HomePage;
