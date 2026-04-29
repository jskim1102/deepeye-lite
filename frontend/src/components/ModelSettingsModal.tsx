import { useEffect, useState, useMemo } from "react";
import Modal from "./Modal";
import { resolveClassColor } from "../utils/colors";

/**
 * 카메라별 — 선택된 각 모델의 conf, 활성 클래스, 클래스별 bbox 색상 통합 설정 모달.
 *
 * Accordion: 한 번에 한 모델만 펼침. 모델 헤더 클릭 시 토글.
 * 펼친 모델: conf 슬라이더 + 클래스 박스 (검색·전체/해제·체크박스+색상 스워치).
 * 색상 스워치: native <input type="color">. 우클릭 → 기본 팔레트 복원.
 *
 * §4.19 의 client-side overlay 위에서 동작 — 변경 즉시 canvas 에 반영 (backend 무관).
 */

const API_PORT = import.meta.env.VITE_API_PORT;
const API_BASE = `http://${window.location.hostname}:${API_PORT}`;

export interface ModelSettings {
  conf?: number;
  classes?: number[] | null;            // null/undef=전체, []=비활성, [id..]=일부
  colors?: Record<number, string>;      // class_id → hex (override 만)
}

interface ClassInfo {
  id: number;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  cameraName: string;
  fallbackConf: number;
  selectedModels: string[];
  settings: Record<string, ModelSettings>;
  onSettingsChange: (next: Record<string, ModelSettings>) => void;
}

function ModelSettingsModal({
  open,
  onClose,
  cameraName,
  fallbackConf,
  selectedModels,
  settings,
  onSettingsChange,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [classesByModel, setClassesByModel] = useState<Record<string, ClassInfo[]>>({});
  const [loadingModel, setLoadingModel] = useState<string | null>(null);
  const [errorByModel, setErrorByModel] = useState<Record<string, string>>({});

  // 모달 열릴 때 모델이 1개뿐이면 자동 펼침
  useEffect(() => {
    if (open && selectedModels.length === 1) setExpanded(selectedModels[0]);
  }, [open, selectedModels]);

  // 펼친 모델의 클래스 목록 lazy fetch
  useEffect(() => {
    if (!expanded) return;
    if (classesByModel[expanded]) return;
    let cancelled = false;
    setLoadingModel(expanded);
    fetch(`${API_BASE}/api/inference/models/${encodeURIComponent(expanded)}/classes`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as ClassInfo[];
      })
      .then((data) => {
        if (cancelled) return;
        setClassesByModel((prev) => ({ ...prev, [expanded]: data }));
        setErrorByModel((prev) => ({ ...prev, [expanded]: "" }));
      })
      .catch((e) => {
        if (!cancelled) setErrorByModel((prev) => ({ ...prev, [expanded]: `클래스 로드 실패: ${e}` }));
      })
      .finally(() => {
        if (!cancelled) setLoadingModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, classesByModel]);

  const updateModel = (model: string, patch: Partial<ModelSettings>) => {
    const prev = settings[model] ?? {};
    onSettingsChange({ ...settings, [model]: { ...prev, ...patch } });
  };

  return (
    <Modal open={open} onClose={onClose} title={`${cameraName} — 모델 설정`}>
      {selectedModels.length === 0 ? (
        <div style={styles.empty}>
          선택된 모델이 없습니다. 먼저 [모델] 에서 모델을 선택하세요.
        </div>
      ) : (
        <ul style={styles.list}>
          {selectedModels.map((model) => {
            const isExpanded = expanded === model;
            const ms = settings[model] ?? {};
            const conf = ms.conf ?? fallbackConf;
            const overridden = ms.conf !== undefined;
            return (
              <li key={model} style={styles.modelItem}>
                <button
                  style={styles.modelHeader}
                  onClick={() => setExpanded(isExpanded ? null : model)}
                >
                  <span style={styles.caret}>{isExpanded ? "▼" : "▶"}</span>
                  <span style={styles.modelName}>{model}</span>
                  <span style={styles.confBadge}>
                    {conf.toFixed(2)}
                    {!overridden && <span style={styles.fallback}> (기본)</span>}
                  </span>
                </button>
                {isExpanded && (
                  <div style={styles.modelBody}>
                    <ConfSection
                      conf={conf}
                      overridden={overridden}
                      onChange={(v) => updateModel(model, { conf: v })}
                      onReset={() => updateModel(model, { conf: undefined })}
                    />
                    <ClassSection
                      classes={classesByModel[model] ?? []}
                      loading={loadingModel === model}
                      error={errorByModel[model]}
                      enabledClasses={ms.classes}
                      colors={ms.colors}
                      onEnabledChange={(c) => updateModel(model, { classes: c })}
                      onColorsChange={(c) => updateModel(model, { colors: c })}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

// ──────────────────────── Conf 슬라이더 ────────────────────────
function ConfSection({
  conf,
  overridden,
  onChange,
  onReset,
}: {
  conf: number;
  overridden: boolean;
  onChange: (v: number) => void;
  onReset: () => void;
}) {
  return (
    <div style={styles.confRow}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={conf}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={styles.slider}
      />
      {overridden && (
        <button onClick={onReset} style={styles.resetBtn} title="기본값으로">
          기본값
        </button>
      )}
    </div>
  );
}

// ──────────────────────── 클래스 섹션 ────────────────────────
function ClassSection({
  classes,
  loading,
  error,
  enabledClasses,
  colors,
  onEnabledChange,
  onColorsChange,
}: {
  classes: ClassInfo[];
  loading: boolean;
  error?: string;
  enabledClasses?: number[] | null;
  colors?: Record<number, string>;
  onEnabledChange: (c: number[] | null) => void;
  onColorsChange: (c: Record<number, string>) => void;
}) {
  const [search, setSearch] = useState("");

  const isEnabled = (id: number) => {
    if (enabledClasses === undefined || enabledClasses === null) return true;
    return enabledClasses.includes(id);
  };

  const allIds = useMemo(() => classes.map((c) => c.id), [classes]);
  const enabledCount =
    enabledClasses === undefined || enabledClasses === null
      ? classes.length
      : enabledClasses.length;

  const toggle = (id: number) => {
    let current: number[];
    if (enabledClasses === undefined || enabledClasses === null) {
      current = [...allIds];
    } else {
      current = [...enabledClasses];
    }
    const idx = current.indexOf(id);
    if (idx >= 0) current.splice(idx, 1);
    else current.push(id);
    if (current.length === allIds.length) onEnabledChange(null);
    else onEnabledChange(current.sort((a, b) => a - b));
  };

  const selectAll = () => onEnabledChange(null);
  const clearAll = () => onEnabledChange([]);

  const setColor = (id: number, hex: string) => {
    onColorsChange({ ...(colors ?? {}), [id]: hex });
  };
  const resetColor = (id: number) => {
    if (!colors || !(id in colors)) return;
    const next = { ...colors };
    delete next[id];
    onColorsChange(next);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return classes;
    return classes.filter((c) => c.name.toLowerCase().includes(q));
  }, [classes, search]);

  if (loading) return <div style={styles.classMsg}>클래스 로드 중...</div>;
  if (error) return <div style={styles.classError}>{error}</div>;
  if (classes.length === 0)
    return <div style={styles.classMsg}>클래스 없음</div>;

  return (
    <div style={styles.classBox}>
      <div style={styles.classHead}>
        <span style={styles.classCount}>
          클래스 {enabledCount}/{classes.length}
        </span>
        <button onClick={selectAll} style={styles.smallBtn}>전체</button>
        <button onClick={clearAll} style={styles.smallBtn}>해제</button>
      </div>
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="검색..."
        style={styles.search}
      />
      <ul style={styles.classList}>
        {filtered.map((c) => {
          const checked = isEnabled(c.id);
          const color = resolveClassColor(c.id, colors);
          const hasOverride = colors !== undefined && c.id in colors;
          return (
            <li key={c.id} style={styles.classRow}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(c.id)}
                style={styles.checkbox}
                aria-label={c.name}
              />
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(c.id, e.target.value)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  resetColor(c.id);
                }}
                style={styles.colorSwatch}
                title={
                  hasOverride
                    ? "클릭: 변경 / 우클릭: 기본 복원"
                    : "클릭하여 색상 선택"
                }
              />
              <span style={styles.className}>{c.name}</span>
              <span style={styles.classId}>#{c.id}</span>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li style={styles.classMsg}>'{search}' 검색 결과 없음</li>
        )}
      </ul>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  empty: {
    textAlign: "center", color: "#aaaaaa", fontSize: "0.9rem", padding: "1.5rem 0.5rem",
  },
  list: {
    listStyle: "none", margin: 0, padding: 0,
    display: "flex", flexDirection: "column", gap: "0.5rem",
  },
  modelItem: { backgroundColor: "#16213e", borderRadius: "6px", overflow: "hidden" },
  modelHeader: {
    width: "100%", display: "flex", alignItems: "center", gap: "0.6rem",
    padding: "0.7rem 0.9rem", background: "transparent", border: "none",
    cursor: "pointer", color: "#ffffff", fontSize: "0.9rem", textAlign: "left",
  },
  caret: { color: "#aaaaaa", width: "14px" },
  modelName: { flex: 1 },
  confBadge: { color: "#4ade80", fontSize: "0.85rem", fontWeight: 600 },
  fallback: { color: "#888", fontWeight: 400, fontSize: "0.75rem" },
  modelBody: {
    padding: "0 0.9rem 0.9rem",
    display: "flex", flexDirection: "column", gap: "0.7rem",
  },
  confRow: { display: "flex", alignItems: "center", gap: "0.5rem" },
  slider: { flex: 1, accentColor: "#4caf50", cursor: "pointer" },
  resetBtn: {
    padding: "0.25rem 0.6rem", borderRadius: "4px",
    border: "1px solid #555", backgroundColor: "transparent",
    color: "#aaaaaa", fontSize: "0.7rem", cursor: "pointer",
  },
  classBox: {
    backgroundColor: "#0f1a2e", borderRadius: "6px", padding: "0.6rem",
    display: "flex", flexDirection: "column", gap: "0.5rem",
  },
  classHead: { display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" },
  classCount: { color: "#aaaaaa", fontSize: "0.8rem", flex: 1 },
  smallBtn: {
    padding: "0.2rem 0.5rem", borderRadius: "4px",
    border: "1px solid #2a2a3e", backgroundColor: "transparent",
    color: "#bbbbbb", fontSize: "0.7rem", cursor: "pointer",
  },
  search: {
    width: "100%", padding: "0.35rem 0.5rem", borderRadius: "4px",
    border: "1px solid #2a2a3e", backgroundColor: "#0a0e1f",
    color: "#ffffff", fontSize: "0.8rem",
  },
  classList: {
    listStyle: "none", margin: 0, padding: 0,
    maxHeight: "240px", overflowY: "auto",
    backgroundColor: "#16213e", borderRadius: "4px",
  },
  classRow: {
    display: "flex", alignItems: "center", gap: "0.55rem",
    padding: "0.35rem 0.6rem", borderBottom: "1px solid #1a1a2e",
    minHeight: "36px", fontSize: "0.85rem",
  },
  checkbox: {
    width: "16px", height: "16px", accentColor: "#4caf50", cursor: "pointer",
  },
  colorSwatch: {
    width: "22px", height: "22px",
    border: "1px solid #2a2a3e", borderRadius: "4px",
    padding: 0, cursor: "pointer", backgroundColor: "transparent",
  },
  className: { flex: 1, color: "#ffffff" },
  classId: { color: "#666", fontSize: "0.7rem", fontFamily: "monospace" },
  classMsg: {
    padding: "0.6rem", color: "#aaaaaa", fontSize: "0.8rem", textAlign: "center",
  },
  classError: { padding: "0.6rem", color: "#f87171", fontSize: "0.8rem" },
};

export default ModelSettingsModal;
