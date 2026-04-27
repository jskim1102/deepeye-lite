import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import HlsPlayer from "../components/HlsPlayer";

const API_PORT = import.meta.env.VITE_API_PORT;
const API_BASE = `http://${window.location.hostname}:${API_PORT}`;

interface IpCam {
  id: number;
  name: string;
  rtsp_url: string;
  stream_key: string;
  created_at: string;
}

function getGridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

function IpcamPage() {
  const navigate = useNavigate();
  const [cams, setCams] = useState<IpCam[]>([]);
  const [name, setName] = useState("");
  const [rtspUrl, setRtspUrl] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchCams = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/ipcams`);
      const data: IpCam[] = await res.json();
      setCams(data);
    } catch {
      /* 네트워크 오류 무시 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCams();
  }, [fetchCams]);

  const handleAdd = async () => {
    if (!rtspUrl.trim()) return;
    const camName = name.trim() || String(cams.length + 1);
    await fetch(`${API_BASE}/api/ipcams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: camName, rtsp_url: rtspUrl.trim() }),
    });
    setName("");
    setRtspUrl("");
    fetchCams();
  };

  const handleUpdate = async () => {
    if (editingId === null || !name.trim() || !rtspUrl.trim()) return;
    await fetch(`${API_BASE}/api/ipcams/${editingId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), rtsp_url: rtspUrl.trim() }),
    });
    setEditingId(null);
    setName("");
    setRtspUrl("");
    fetchCams();
  };

  const handleDelete = async (id: number) => {
    await fetch(`${API_BASE}/api/ipcams/${id}`, { method: "DELETE" });
    fetchCams();
  };

  const startEdit = (cam: IpCam) => {
    setEditingId(cam.id);
    setName(cam.name);
    setRtspUrl(cam.rtsp_url);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setName("");
    setRtspUrl("");
  };

  const columns = getGridColumns(cams.length);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button style={styles.backButton} onClick={() => navigate("/")}>
          ← 돌아가기
        </button>
        <h1 style={styles.title}>IP CAM 관리</h1>
      </div>

      {/* 입력 폼 */}
      <div style={styles.form}>
        <input
          style={styles.inputName}
          placeholder={editingId === null ? String(cams.length + 1) : "카메라 이름"}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          style={styles.inputUrl}
          placeholder="rtsp://192.168.0.100:554/stream"
          value={rtspUrl}
          onChange={(e) => setRtspUrl(e.target.value)}
        />
        {editingId === null ? (
          <button style={styles.addButton} onClick={handleAdd}>
            추가
          </button>
        ) : (
          <>
            <button style={styles.saveButton} onClick={handleUpdate}>
              저장
            </button>
            <button style={styles.cancelButton} onClick={cancelEdit}>
              취소
            </button>
          </>
        )}
      </div>

      {/* 목록 */}
      {loading ? (
        <p style={styles.info}>불러오는 중...</p>
      ) : cams.length === 0 ? (
        <p style={styles.info}>등록된 IP CAM이 없습니다</p>
      ) : (
        <>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>이름</th>
                <th style={styles.th}>RTSP 주소</th>
                <th style={{ ...styles.th, width: "120px" }}>작업</th>
              </tr>
            </thead>
            <tbody>
              {cams.map((cam) => (
                <tr key={cam.id} style={styles.tr}>
                  <td style={styles.td}>{cam.name}</td>
                  <td style={{ ...styles.td, fontSize: "0.85rem", color: "#93c5fd" }}>
                    {cam.rtsp_url}
                  </td>
                  <td style={styles.td}>
                    <button style={styles.editButton} onClick={() => startEdit(cam)}>
                      수정
                    </button>
                    <button style={styles.deleteButton} onClick={() => handleDelete(cam.id)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 스트리밍 그리드 */}
          <div
            style={{
              ...styles.grid,
              gridTemplateColumns: `repeat(${columns}, 1fr)`,
            }}
          >
            {cams.map((cam) => (
              <HlsPlayer key={cam.id} streamKey={cam.stream_key} name={cam.name} />
            ))}
          </div>
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
  form: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "1.5rem",
    padding: "0.8rem",
    backgroundColor: "#16213e",
    borderRadius: "8px",
    flexWrap: "wrap",
  },
  inputName: {
    padding: "0.5rem",
    borderRadius: "6px",
    border: "1px solid #444",
    backgroundColor: "#0f3460",
    color: "#ffffff",
    fontSize: "0.9rem",
    width: "150px",
  },
  inputUrl: {
    padding: "0.5rem",
    borderRadius: "6px",
    border: "1px solid #444",
    backgroundColor: "#0f3460",
    color: "#ffffff",
    fontSize: "0.9rem",
    flex: 1,
    minWidth: "250px",
  },
  addButton: {
    padding: "0.5rem 1.2rem",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#1a6b3c",
    color: "#ffffff",
    fontSize: "0.9rem",
  },
  saveButton: {
    padding: "0.5rem 1.2rem",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#2563eb",
    color: "#ffffff",
    fontSize: "0.9rem",
  },
  cancelButton: {
    padding: "0.5rem 1.2rem",
    borderRadius: "6px",
    border: "1px solid #aaaaaa",
    cursor: "pointer",
    backgroundColor: "transparent",
    color: "#ffffff",
    fontSize: "0.9rem",
  },
  info: {
    color: "#aaaaaa",
    textAlign: "center",
    marginTop: "3rem",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    backgroundColor: "#16213e",
    borderRadius: "8px",
    overflow: "hidden",
    marginBottom: "1.5rem",
  },
  th: {
    padding: "0.7rem 0.8rem",
    textAlign: "left",
    backgroundColor: "#0f3460",
    fontSize: "0.85rem",
    color: "#aaaaaa",
  },
  tr: {
    borderBottom: "1px solid #1a1a2e",
  },
  td: {
    padding: "0.6rem 0.8rem",
    fontSize: "0.9rem",
  },
  editButton: {
    padding: "0.3rem 0.7rem",
    marginRight: "0.3rem",
    borderRadius: "4px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#2563eb",
    color: "#ffffff",
    fontSize: "0.8rem",
  },
  deleteButton: {
    padding: "0.3rem 0.7rem",
    borderRadius: "4px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#dc2626",
    color: "#ffffff",
    fontSize: "0.8rem",
  },
  grid: {
    display: "grid",
    gap: "0.5rem",
  },
};

export default IpcamPage;
