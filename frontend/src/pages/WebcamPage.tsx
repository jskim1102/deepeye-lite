import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import BboxOverlay, { type Detection } from "../components/BboxOverlay";

interface WebcamInfo {
  index: number;
  name: string;
  available: boolean;
}

const API_PORT = import.meta.env.VITE_API_PORT;
const API_BASE = `http://${window.location.hostname}:${API_PORT}`;
const WS_BASE = `ws://${window.location.hostname}:${API_PORT}`;

function getGridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

const RECONNECT_DELAY = 2000;

/** WebSocket 으로 raw JPEG (binary) + detections JSON (text) 을 받는다 (§4.19 옵션 2) */
function WebcamFrame({ index, name }: { index: number; name: string }) {
  const wsRef = useRef<WebSocket | null>(null);
  const blobUrlRef = useRef<string>("");
  const [imgSrc, setImgSrc] = useState("");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let unmounted = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (unmounted) return;

      const ws = new WebSocket(`${WS_BASE}/api/webcams/${index}/ws`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (!unmounted) setConnected(true);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (unmounted) return;
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "detections") setDetections(msg.items as Detection[]);
          } catch {
            /* malformed — 무시 */
          }
        } else {
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
          const blob = new Blob([event.data], { type: "image/jpeg" });
          blobUrlRef.current = URL.createObjectURL(blob);
          setImgSrc(blobUrlRef.current);
        }
      };

      ws.onclose = () => {
        if (unmounted) return;
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, [index]);

  return (
    <div style={styles.streamCard}>
      <p style={styles.camLabel}>
        {name}
        <span style={{ marginLeft: "0.5rem", fontSize: "0.7rem", color: connected ? "#4ade80" : "#f87171" }}>
          {connected ? "● 연결됨" : "● 연결 끊김"}
        </span>
      </p>
      {imgSrc && (
        <BboxOverlay
          imgSrc={imgSrc}
          alt={name}
          detections={detections}
          imgStyle={styles.streamImg}
        />
      )}
    </div>
  );
}

function WebcamPage() {
  const navigate = useNavigate();
  const [webcams, setWebcams] = useState<WebcamInfo[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);

  const fetchWebcams = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/webcams`);
      const data: WebcamInfo[] = await res.json();
      return data;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    fetchWebcams().then((data) => {
      if (data) {
        setWebcams(data);
        setSelected(new Set(data.map((w) => w.index)));
      }
      setLoading(false);
    });
  }, [fetchWebcams]);

  const handleRefresh = async () => {
    setLoading(true);
    const data = await fetchWebcams();
    if (data) {
      setWebcams(data);
      setSelected(new Set(data.map((w) => w.index)));
    }
    setLoading(false);
  };

  const toggleWebcam = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const activeWebcams = webcams.filter((w) => selected.has(w.index));
  const columns = getGridColumns(activeWebcams.length);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button style={styles.backButton} onClick={() => navigate("/")}>
          ← 돌아가기
        </button>
        <h1 style={styles.title}>Webcam 스트리밍</h1>
        <button style={styles.refreshButton} onClick={handleRefresh}>
          새로고침
        </button>
      </div>

      {loading ? (
        <p style={styles.info}>웹캠 스캔 중...</p>
      ) : webcams.length === 0 ? (
        <p style={styles.info}>연결된 웹캠이 없습니다</p>
      ) : (
        <>
          <div style={styles.webcamList}>
            <span style={styles.listLabel}>연결된 웹캠:</span>
            {webcams.map((w) => (
              <label key={w.index} style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={selected.has(w.index)}
                  onChange={() => toggleWebcam(w.index)}
                />
                {w.name}
              </label>
            ))}
          </div>

          {activeWebcams.length === 0 ? (
            <p style={styles.info}>스트리밍할 웹캠을 선택하세요</p>
          ) : (
            <div
              style={{
                ...styles.grid,
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
              }}
            >
              {activeWebcams.map((w) => (
                <WebcamFrame key={w.index} index={w.index} name={w.name} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#1a1a2e",
    color: "#ffffff",
    padding: "1.5rem",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    marginBottom: "1rem",
  },
  backButton: {
    padding: "0.5rem 1rem",
    fontSize: "0.9rem",
    borderRadius: "6px",
    border: "1px solid #aaaaaa",
    cursor: "pointer",
    backgroundColor: "transparent",
    color: "#ffffff",
  },
  title: {
    fontSize: "1.5rem",
    margin: 0,
    flex: 1,
  },
  refreshButton: {
    padding: "0.5rem 1rem",
    fontSize: "0.9rem",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#0f3460",
    color: "#ffffff",
  },
  webcamList: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    flexWrap: "wrap",
    marginBottom: "1rem",
    padding: "0.8rem",
    backgroundColor: "#16213e",
    borderRadius: "8px",
  },
  listLabel: {
    color: "#aaaaaa",
    fontSize: "0.9rem",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: "0.3rem",
    fontSize: "0.9rem",
    cursor: "pointer",
  },
  info: {
    color: "#aaaaaa",
    textAlign: "center",
    marginTop: "3rem",
  },
  grid: {
    display: "grid",
    gap: "0.5rem",
  },
  streamCard: {
    backgroundColor: "#0f3460",
    borderRadius: "8px",
    overflow: "hidden",
  },
  camLabel: {
    margin: 0,
    padding: "0.4rem 0.6rem",
    fontSize: "0.8rem",
    backgroundColor: "#16213e",
  },
  streamImg: {
    width: "100%",
    display: "block",
    aspectRatio: "16/9",
    objectFit: "cover",
    backgroundColor: "#000000",
  },
};

export default WebcamPage;
