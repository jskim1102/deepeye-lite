import Modal from "./Modal";

/**
 * 카메라별 — 선택된 각 모델마다 신뢰도(confidence) 를 개별 조정하는 모달.
 *
 * - 모델별 conf 값이 미설정이면 카메라 기본 conf(fallbackConf) 가 사용됨
 * - 슬라이더를 움직이면 해당 모델만 override
 * - 선택된 모델이 없으면 안내 메시지 표시
 */

interface Props {
  open: boolean;
  onClose: () => void;
  cameraName: string;
  fallbackConf: number; // 모델별 conf 가 없을 때 사용되는 카메라 기본값
  selectedModels: string[];
  modelConfs: Record<string, number>; // model name -> conf (없으면 fallback)
  onModelConfsChange: (confs: Record<string, number>) => void;
}

function ModelConfModal({
  open,
  onClose,
  cameraName,
  fallbackConf,
  selectedModels,
  modelConfs,
  onModelConfsChange,
}: Props) {
  const handleConfChange = (model: string, value: number) => {
    onModelConfsChange({ ...modelConfs, [model]: value });
  };

  const handleReset = (model: string) => {
    const next = { ...modelConfs };
    delete next[model];
    onModelConfsChange(next);
  };

  return (
    <Modal open={open} onClose={onClose} title={`${cameraName} — 모델별 신뢰도`}>
      {selectedModels.length === 0 ? (
        <div style={styles.empty}>
          선택된 모델이 없습니다. 먼저 [모델] 에서 모델을 선택하세요.
        </div>
      ) : (
        <ul style={styles.list}>
          {selectedModels.map((model) => {
            const overridden = model in modelConfs;
            const value = overridden ? modelConfs[model] : fallbackConf;
            return (
              <li key={model} style={styles.row}>
                <div style={styles.rowHead}>
                  <span style={styles.modelName}>{model}</span>
                  <span style={styles.confValue}>
                    {value.toFixed(2)}
                    {!overridden && <span style={styles.fallback}> (기본)</span>}
                  </span>
                </div>
                <div style={styles.sliderRow}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={value}
                    onChange={(e) =>
                      handleConfChange(model, parseFloat(e.target.value))
                    }
                    style={styles.slider}
                  />
                  {overridden && (
                    <button
                      onClick={() => handleReset(model)}
                      style={styles.resetBtn}
                      title="카메라 기본값으로 되돌리기"
                    >
                      기본값
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  empty: {
    textAlign: "center",
    color: "#aaaaaa",
    fontSize: "0.9rem",
    padding: "1.5rem 0.5rem",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.6rem",
  },
  row: {
    backgroundColor: "#16213e",
    borderRadius: "6px",
    padding: "0.7rem 0.9rem",
  },
  rowHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.4rem",
  },
  modelName: {
    color: "#ffffff",
    fontSize: "0.9rem",
  },
  confValue: {
    color: "#4ade80",
    fontSize: "0.85rem",
    fontWeight: 600,
  },
  fallback: {
    color: "#888",
    fontWeight: 400,
    fontSize: "0.75rem",
  },
  sliderRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  slider: {
    flex: 1,
    accentColor: "#4caf50",
    cursor: "pointer",
  },
  resetBtn: {
    padding: "0.25rem 0.6rem",
    borderRadius: "4px",
    border: "1px solid #555",
    backgroundColor: "transparent",
    color: "#aaaaaa",
    fontSize: "0.7rem",
    cursor: "pointer",
  },
};

export default ModelConfModal;
