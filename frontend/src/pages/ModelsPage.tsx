import { useEffect, useState, useCallback, useRef } from "react";

const API_PORT = import.meta.env.VITE_API_PORT;
const API_BASE = `http://${window.location.hostname}:${API_PORT}`;

interface ModelInfo {
  name: string;
  type: "preset" | "custom";
  size_mb: number | null;
}

function ModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/inference/models`);
      const data: ModelInfo[] = await res.json();
      setModels(data);
    } catch (e) {
      setError(`목록 로드 실패: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const handleUpload = async () => {
    const f = fileRef.current?.files?.[0];
    if (!f) {
      setError("파일을 선택하세요");
      return;
    }
    if (!f.name.endsWith(".pt")) {
      setError(".pt 파일만 업로드 가능합니다");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch(`${API_BASE}/api/inference/models`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${res.status}`);
      }
      if (fileRef.current) fileRef.current.value = "";
      await fetchModels();
    } catch (e) {
      setError(`업로드 실패: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`'${name}' 모델을 삭제하시겠습니까?`)) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/api/inference/models/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${res.status}`);
      }
      await fetchModels();
    } catch (e) {
      setError(`삭제 실패: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const presets = models.filter((m) => m.type === "preset");
  const customs = models.filter((m) => m.type === "custom");

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>모델 관리</h1>

      <p style={styles.subtitle}>
        Custom 학습 모델(`.pt`) 을 업로드하면 헤더 드롭다운에 자동으로 추가됩니다.
      </p>

      {/* 업로드 폼 */}
      <div style={styles.uploadForm}>
        <input
          ref={fileRef}
          type="file"
          accept=".pt"
          style={styles.fileInput}
          disabled={busy}
        />
        <button onClick={handleUpload} disabled={busy} style={styles.uploadBtn}>
          {busy ? "업로드 중..." : "업로드"}
        </button>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      {/* Custom 모델 */}
      <h2 style={styles.section}>Custom 업로드 ({customs.length})</h2>
      {loading ? (
        <p style={styles.info}>불러오는 중...</p>
      ) : customs.length === 0 ? (
        <p style={styles.info}>업로드된 custom 모델이 없습니다.</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>파일명</th>
              <th style={styles.th}>크기</th>
              <th style={{ ...styles.th, width: "100px" }}>작업</th>
            </tr>
          </thead>
          <tbody>
            {customs.map((m) => (
              <tr key={m.name} style={styles.tr}>
                <td style={styles.td}>{m.name}</td>
                <td style={styles.td}>{m.size_mb} MB</td>
                <td style={styles.td}>
                  <button
                    style={styles.deleteBtn}
                    onClick={() => handleDelete(m.name)}
                    disabled={busy}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Preset (참고용) */}
      <h2 style={styles.section}>Preset (5종, 첫 사용 시 자동 다운로드)</h2>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>파일명</th>
            <th style={styles.th}>비고</th>
          </tr>
        </thead>
        <tbody>
          {presets.map((m) => (
            <tr key={m.name} style={styles.tr}>
              <td style={styles.td}>{m.name}</td>
              <td style={{ ...styles.td, color: "#aaaaaa" }}>
                ultralytics 자동 다운로드
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#1a1a2e",
    color: "#ffffff",
    padding: "1.5rem",
    maxWidth: "900px",
    margin: "0 auto",
  },
  title: {
    fontSize: "1.5rem",
    margin: 0,
    marginBottom: "0.3rem",
  },
  subtitle: {
    color: "#aaaaaa",
    fontSize: "0.9rem",
    marginBottom: "1.5rem",
  },
  uploadForm: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
    padding: "0.8rem",
    backgroundColor: "#16213e",
    borderRadius: "8px",
    marginBottom: "0.5rem",
  },
  fileInput: {
    flex: 1,
    color: "#ffffff",
  },
  uploadBtn: {
    padding: "0.5rem 1.2rem",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#1a6b3c",
    color: "#ffffff",
    fontSize: "0.9rem",
  },
  error: {
    color: "#f87171",
    fontSize: "0.85rem",
    marginTop: "0.5rem",
  },
  section: {
    fontSize: "1.1rem",
    marginTop: "2rem",
    marginBottom: "0.6rem",
  },
  info: {
    color: "#aaaaaa",
    fontStyle: "italic",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    backgroundColor: "#16213e",
    borderRadius: "8px",
    overflow: "hidden",
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
  deleteBtn: {
    padding: "0.3rem 0.7rem",
    borderRadius: "4px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#dc2626",
    color: "#ffffff",
    fontSize: "0.8rem",
  },
};

export default ModelsPage;
