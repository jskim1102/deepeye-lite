import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";

const API_PORT = import.meta.env.VITE_API_PORT;
const API_BASE = `http://${window.location.hostname}:${API_PORT}`;

interface InferenceConfig {
  enabled: boolean;
  model: string;
  conf_threshold: number;
  device: string;
}

/**
 * 페이지 상단 네비게이션 헤더.
 * v3.0 추론 컨트롤(모델/신뢰도/ON-OFF) 은 `InferenceControls` 컴포넌트로 분리되어
 * 페이지 본문(IpcamPage 등)에 배치됨. 헤더에는 device 만 시스템 정보로 표시.
 */
function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const [device, setDevice] = useState<string>("");

  useEffect(() => {
    fetch(`${API_BASE}/api/inference/config`)
      .then((r) => r.json())
      .then((cfg: InferenceConfig) => setDevice(cfg.device))
      .catch(() => setDevice(""));
  }, [location.pathname]);

  return (
    <header style={styles.header}>
      <div style={styles.left}>
        <span style={styles.brand} onClick={() => navigate("/")}>
          DeepEye Lite
        </span>
        <nav style={styles.nav}>
          <NavLink to="/webcam" current={location.pathname === "/webcam"}>
            Webcam
          </NavLink>
          <NavLink to="/ipcam" current={location.pathname === "/ipcam"}>
            IP CAM
          </NavLink>
          <NavLink to="/models" current={location.pathname === "/models"}>
            모델
          </NavLink>
        </nav>
      </div>
      <div style={styles.right}>
        {device && (
          <span style={styles.device} title="추론 디바이스">
            {device}
          </span>
        )}
      </div>
    </header>
  );
}

function NavLink({
  to,
  current,
  children,
}: {
  to: string;
  current: boolean;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <span
      style={{
        ...styles.navLink,
        color: current ? "#ffffff" : "#aaaaaa",
        borderBottom: current ? "2px solid #4caf50" : "2px solid transparent",
      }}
      onClick={() => navigate(to)}
    >
      {children}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.75rem 1.5rem",
    backgroundColor: "#0f0f1f",
    color: "#ffffff",
    borderBottom: "1px solid #2a2a3e",
    position: "sticky",
    top: 0,
    zIndex: 100,
  },
  left: {
    display: "flex",
    alignItems: "center",
    gap: "2rem",
  },
  brand: {
    fontSize: "1.25rem",
    fontWeight: 600,
    cursor: "pointer",
    userSelect: "none",
  },
  nav: {
    display: "flex",
    gap: "1.25rem",
  },
  navLink: {
    cursor: "pointer",
    paddingBottom: "0.25rem",
    fontSize: "0.95rem",
    transition: "color 0.15s, border-color 0.15s",
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
  },
  device: {
    fontSize: "0.75rem",
    color: "#aaaaaa",
    fontFamily: "monospace",
    padding: "0.2rem 0.5rem",
    backgroundColor: "#16213e",
    borderRadius: "4px",
  },
};

export default Header;
