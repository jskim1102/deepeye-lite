import { useEffect, useRef, useState, useCallback } from "react";
import Modal from "./Modal";

const API_PORT = import.meta.env.VITE_API_PORT;
const API_BASE = `http://${window.location.hostname}:${API_PORT}`;

const PRESET_LABELS: Record<string, string> = {
  "yolo26n.pt": "yolo26n (nano · 가장 빠름)",
  "yolo26s.pt": "yolo26s (small · 균형)",
  "yolo26m.pt": "yolo26m (medium)",
  "yolo26l.pt": "yolo26l (large)",
  "yolo26x.pt": "yolo26x (xlarge · 가장 정확)",
};

interface ModelInfo {
  name: string;
  type: "preset" | "custom";
  size_mb: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  cameraName: string;
  // 현재 선택된 모델 목록 (즉시 갱신 받기 위해 부모에서 관리)
  selected: string[];
  onSelectedChange: (models: string[]) => void;
}

/**
 * 카메라별 사용 모델 선택 + 전역 모델 업로드/삭제 통합 모달.
 *
 * - 체크박스 토글 → 즉시 부모에 새 list 전달 (부모가 PUT 처리)
 * - 새 모델 업로드 → 모달 안에서 직접
 * - Custom 모델 삭제 → 확인 후. 사용 중이던 모델이면 selected 에서도 제거.
 */
function ModelManagerModal({
  open,
  onClose,
  cameraName,
  selected,
  onSelectedChange,
}: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchModels = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/inference/models`);
      const data: ModelInfo[] = await r.json();
      setModels(data);
    } catch (e) {
      setError(`목록 로드 실패: ${e}`);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchModels();
      setError("");
    }
  }, [open, fetchModels]);

  const toggle = (name: string) => {
    const next = selected.includes(name)
      ? selected.filter((n) => n !== name)
      : [...selected, name];
    onSelectedChange(next);
  };

  const handleUpload = async () => {
    const f = fileRef.current?.files?.[0];
    if (!f) return setError("파일을 선택하세요");
    if (!f.name.endsWith(".pt")) return setError(".pt 파일만 가능");
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`${API_BASE}/api/inference/models`, {
        method: "POST",
        body: fd,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${r.status}`);
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
    if (!confirm(`'${name}' 을(를) 삭제하시겠습니까?`)) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(
        `${API_BASE}/api/inference/models/${encodeURIComponent(name)}`,
        { method: "DELETE" }
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.detail || `HTTP ${r.status}`);
      }
      // 사용 중이던 모델이면 선택에서도 제거
      if (selected.includes(name)) {
        onSelectedChange(selected.filter((n) => n !== name));
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
    <Modal open={open} onClose={onClose} title={`${cameraName} — 모델 관리`}>
      {/* 업로드 영역 */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>새 모델 업로드</div>
        <div style={styles.uploadRow}>
          <input
            ref={fileRef}
            type="file"
            accept=".pt"
            disabled={busy}
            style={styles.fileInput}
          />
          <button onClick={handleUpload} disabled={busy} style={styles.uploadBtn}>
            {busy ? "업로드 중..." : "업로드"}
          </button>
        </div>
      </div>

      {/* 사용 모델 선택 */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          사용 모델 선택 — {selected.length} 개 활성
        </div>
        <ul style={styles.modelList}>
          {presets.map((m) => (
            <ModelRow
              key={m.name}
              checked={selected.includes(m.name)}
              onToggle={() => toggle(m.name)}
              primaryText={m.name}
              secondaryText={PRESET_LABELS[m.name] ?? "(preset)"}
            />
          ))}
          {customs.length > 0 && <li style={styles.divider}>── Custom ──</li>}
          {customs.map((m) => (
            <ModelRow
              key={m.name}
              checked={selected.includes(m.name)}
              onToggle={() => toggle(m.name)}
              primaryText={m.name}
              secondaryText={m.size_mb !== null ? `${m.size_mb} MB` : ""}
              onDelete={() => handleDelete(m.name)}
              busy={busy}
            />
          ))}
        </ul>
      </div>

      {error && <div style={styles.error}>{error}</div>}
    </Modal>
  );
}

interface RowProps {
  checked: boolean;
  onToggle: () => void;
  primaryText: string;
  secondaryText?: string;
  onDelete?: () => void;
  busy?: boolean;
}

function ModelRow({
  checked,
  onToggle,
  primaryText,
  secondaryText,
  onDelete,
  busy,
}: RowProps) {
  return (
    <li style={styles.row}>
      <label style={styles.rowLabel}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          style={styles.checkbox}
        />
        <span style={styles.rowName}>{primaryText}</span>
        {secondaryText && (
          <span style={styles.rowSecondary}>— {secondaryText}</span>
        )}
      </label>
      {onDelete && (
        <button
          onClick={onDelete}
          disabled={busy}
          style={styles.deleteBtn}
          title="custom 모델 삭제"
        >
          삭제
        </button>
      )}
    </li>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    marginBottom: "1rem",
  },
  sectionTitle: {
    fontSize: "0.85rem",
    color: "#aaaaaa",
    marginBottom: "0.5rem",
  },
  uploadRow: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
  },
  fileInput: {
    flex: 1,
    color: "#ffffff",
    fontSize: "0.85rem",
  },
  uploadBtn: {
    padding: "0.45rem 1rem",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#1a6b3c",
    color: "#ffffff",
    fontSize: "0.85rem",
  },
  modelList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    backgroundColor: "#16213e",
    borderRadius: "6px",
    overflow: "hidden",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0.6rem 0.8rem",
    borderBottom: "1px solid #1a1a2e",
    minHeight: "44px", // 모바일 탭 타겟 확보
  },
  rowLabel: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flex: 1,
    cursor: "pointer",
    fontSize: "0.9rem",
  },
  checkbox: {
    width: "18px",
    height: "18px",
    accentColor: "#4caf50",
    cursor: "pointer",
  },
  rowName: {
    fontFamily: "monospace",
    color: "#ffffff",
  },
  rowSecondary: {
    color: "#aaaaaa",
    fontSize: "0.8rem",
  },
  divider: {
    padding: "0.5rem 0.8rem",
    color: "#666",
    fontSize: "0.75rem",
    backgroundColor: "#0f3460",
  },
  deleteBtn: {
    padding: "0.3rem 0.7rem",
    borderRadius: "4px",
    border: "none",
    cursor: "pointer",
    backgroundColor: "#dc2626",
    color: "#ffffff",
    fontSize: "0.75rem",
  },
  error: {
    marginTop: "0.5rem",
    color: "#f87171",
    fontSize: "0.85rem",
  },
};

export default ModelManagerModal;
