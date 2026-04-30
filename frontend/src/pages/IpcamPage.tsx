import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import SegmentedToggle from "../components/SegmentedToggle";
import ModelManagerModal from "../components/ModelManagerModal";
import ModelSettingsModal, {
  type ModelSettings,
} from "../components/ModelSettingsModal";
import BboxOverlay, { type Detection } from "../components/BboxOverlay";

const API_PORT = import.meta.env.VITE_API_PORT;
const API_BASE = `http://${window.location.hostname}:${API_PORT}`;
const WS_BASE = `ws://${window.location.hostname}:${API_PORT}`;
const RECONNECT_DELAY = 2000;

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

/**
 * v3.0 — IP CAM 은 WebSocket 으로 raw JPEG (binary) + detections JSON (text) 를 받는다.
 * §4.19 옵션 2: backend 는 raw 영상만, frontend canvas 가 bbox 오버레이.
 */
function IpcamFrame({
  streamKey,
  name,
  inferenceActive,
  settings,
}: {
  streamKey: string;
  name: string;
  // 카메라가 실제로 추론을 돌리는 상태인지 (추론 ON 토글 && 모델 ≥ 1).
  // false 면 brand-new detections JSON 이 안 오므로 frontend 가 직접 비워줘야 잔존 방지.
  inferenceActive: boolean;
  settings?: Record<string, ModelSettings>;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const blobUrlRef = useRef<string>("");
  const inferenceActiveRef = useRef(inferenceActive);
  const [imgSrc, setImgSrc] = useState("");
  const [detections, setDetections] = useState<Detection[]>([]);
  const [connected, setConnected] = useState(false);

  // 추론 OFF 또는 모델 미선택 시 마지막 detections 잔존 방지 — 즉시 비우고
  // ws.onmessage 가 stale 한 detection JSON 을 무시하도록 ref 도 갱신.
  useEffect(() => {
    inferenceActiveRef.current = inferenceActive;
    if (!inferenceActive) setDetections([]);
  }, [inferenceActive]);

  useEffect(() => {
    let unmounted = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (unmounted) return;
      const ws = new WebSocket(`${WS_BASE}/api/ipcams/${streamKey}/ws`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (!unmounted) setConnected(true);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (unmounted) return;
        if (typeof event.data === "string") {
          // detections JSON
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "detections") {
              // 추론 비활성 상태에서 도착한 stale 메시지 무시 (PUT race window)
              if (!inferenceActiveRef.current) return;
              setDetections(msg.items as Detection[]);
            }
          } catch {
            /* malformed — 무시 */
          }
        } else {
          // binary JPEG
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
  }, [streamKey]);

  return (
    <div style={styles.streamCard}>
      <p style={styles.camLabel}>
        {name}
        <span
          style={{
            marginLeft: "0.5rem",
            fontSize: "0.7rem",
            color: connected ? "#4ade80" : "#f87171",
          }}
        >
          {connected ? "● 연결됨" : "● 연결 끊김"}
        </span>
      </p>
      {imgSrc && (
        <BboxOverlay
          imgSrc={imgSrc}
          alt={name}
          detections={detections}
          settings={settings}
          imgStyle={styles.streamImg}
        />
      )}
    </div>
  );
}

interface CamStats {
  active: boolean;
  source_fps: number;
  inference_fps: number;
}

const DEFAULT_CONF = 0.5;

function IpcamPage() {
  const navigate = useNavigate();
  const [cams, setCams] = useState<IpCam[]>([]);
  const [stats, setStats] = useState<Record<string, CamStats>>({});
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [confs, setConfs] = useState<Record<string, number>>({});
  // 카메라별 선택된 모델 목록.
  //   undefined / null  : 미설정 (global 따름)
  //   []                : 추론 안 함
  //   [m1, m2]          : 그 모델들 활성
  const [modelsByCam, setModelsByCam] = useState<Record<string, string[] | null>>({});
  const [modalCamKey, setModalCamKey] = useState<string | null>(null);
  // 카메라별 — 모델별 통합 설정 (conf override + classes filter + class colors). frontend 적용 (§4.20).
  const [modelSettingsByCam, setModelSettingsByCam] = useState<
    Record<string, Record<string, ModelSettings>>
  >({});
  const [confModalCamKey, setConfModalCamKey] = useState<string | null>(null);
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

  // FPS 통계 — 1초 주기 polling. 활성 캡처만 의미 있는 값.
  useEffect(() => {
    if (cams.length === 0) return;
    const fetchAll = async () => {
      const entries = await Promise.all(
        cams.map(async (cam) => {
          try {
            const r = await fetch(`${API_BASE}/api/ipcams/${cam.stream_key}/stats`);
            const data: CamStats = await r.json();
            return [cam.stream_key, data] as const;
          } catch {
            return [cam.stream_key, { active: false, source_fps: 0, inference_fps: 0 }] as const;
          }
        })
      );
      setStats(Object.fromEntries(entries));
    };
    fetchAll();
    const id = window.setInterval(fetchAll, 1000);
    return () => window.clearInterval(id);
  }, [cams]);

  // 카메라별 추론 (enabled + conf + models) 상태 초기 fetch
  useEffect(() => {
    if (cams.length === 0) return;
    const fetchAll = async () => {
      const results = await Promise.all(
        cams.map(async (cam) => {
          try {
            const r = await fetch(`${API_BASE}/api/ipcams/${cam.stream_key}/inference`);
            const data = await r.json();
            return [cam.stream_key, data] as const;
          } catch {
            return [
              cam.stream_key,
              { enabled: true, conf_threshold: null, models: null },
            ] as const;
          }
        })
      );
      // UX 규칙: ON + 빈 모델 조합 금지.
      //   models 가 비어있거나 null 이면 enabled 도 false 로 normalize.
      const normalized = results.map(([k, v]) => {
        const modelsArr = (v.models ?? []) as string[];
        const en = !!v.enabled && modelsArr.length > 0;
        return [k, { enabled: en, conf: v.conf_threshold ?? DEFAULT_CONF, models: modelsArr }] as const;
      });
      setEnabled(Object.fromEntries(normalized.map(([k, v]) => [k, v.enabled])));
      setConfs(Object.fromEntries(normalized.map(([k, v]) => [k, v.conf])));
      setModelsByCam(Object.fromEntries(normalized.map(([k, v]) => [k, v.models])));

      // backend state 와 normalize 결과가 다르면 즉시 PUT 으로 동기화.
      //   - models null → []
      //   - enabled=true 인데 models=[] → enabled=false
      await Promise.all(
        results.map(([k, v]) => {
          const modelsArr = (v.models ?? []) as string[];
          const desiredEn = !!v.enabled && modelsArr.length > 0;
          const needsModelPut = v.models === null || v.models === undefined;
          const needsEnabledPut = !!v.enabled !== desiredEn;
          if (!needsModelPut && !needsEnabledPut) return Promise.resolve();
          const body: Record<string, unknown> = {};
          if (needsModelPut) body.models = [];
          if (needsEnabledPut) body.enabled = desiredEn;
          return fetch(`${API_BASE}/api/ipcams/${k}/inference`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).catch(() => {});
        })
      );
    };
    fetchAll();
  }, [cams]);

  const toggleInference = async (streamKey: string, on: boolean) => {
    setEnabled((prev) => ({ ...prev, [streamKey]: on })); // 낙관적 업데이트
    try {
      const r = await fetch(`${API_BASE}/api/ipcams/${streamKey}/inference`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: on }),
      });
      const data = await r.json();
      setEnabled((prev) => ({ ...prev, [streamKey]: !!data.enabled }));
    } catch {
      setEnabled((prev) => ({ ...prev, [streamKey]: !on }));
    }
  };

  const handleModelsChange = async (streamKey: string, list: string[]) => {
    setModelsByCam((prev) => ({ ...prev, [streamKey]: list })); // 낙관적
    // UX 규칙: 모델이 모두 해제되면 추론도 자동 OFF (ON+빈 모델 조합 방지)
    const body: Record<string, unknown> = { models: list };
    if (list.length === 0 && (enabled[streamKey] ?? true)) {
      setEnabled((prev) => ({ ...prev, [streamKey]: false }));
      body.enabled = false;
    }
    try {
      await fetch(`${API_BASE}/api/ipcams/${streamKey}/inference`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      /* ignore */
    }
  };

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
              {cams.map((cam) => {
                const s = stats[cam.stream_key];
                const camEnabled = enabled[cam.stream_key] ?? true;
                const hasModels = (modelsByCam[cam.stream_key]?.length ?? 0) > 0;
                return (
                  <tr key={cam.id} style={styles.tr}>
                    <td style={styles.td}>{cam.name}</td>
                    <td style={{ ...styles.td, fontSize: "0.85rem", color: "#93c5fd" }}>
                      {/* RTSP URL + FPS 배지 */}
                      <div>
                        {cam.rtsp_url}
                        {s && s.active && (
                          <span
                            style={styles.fpsBadge}
                            title="카메라 원본 fps / YOLO 추론 fps"
                          >
                            카메라 {s.source_fps.toFixed(1)} / 추론 {s.inference_fps.toFixed(1)} fps
                          </span>
                        )}
                        {s && !s.active && (
                          <span style={{ ...styles.fpsBadge, color: "#888" }}>
                            (캡처 미동작)
                          </span>
                        )}
                      </div>
                      {/* RTSP 주소 바로 밑 — 카메라별 추론 컨트롤 (모델 → 추론 → 신뢰도 순) */}
                      <div style={styles.toggleRow}>
                        {/* 모델 — 클릭 시 모달. 선택 0개면 박스/배지 모두 숨김 */}
                        {(() => {
                          const m = modelsByCam[cam.stream_key];
                          if (m === null || m === undefined || m.length === 0) return null;
                          const count = m.length;
                          const showBadge = count >= 2;
                          const text = count === 1 ? m[0] : `${m[0]} +${count - 1}`;
                          return (
                            <>
                              {showBadge && <span style={styles.modelBadge}>{count}</span>}
                              <span style={styles.modelCount}>{text}</span>
                            </>
                          );
                        })()}
                        <button
                          onClick={() => setModalCamKey(cam.stream_key)}
                          style={styles.manageBtn}
                        >
                          모델
                        </button>
                        <button
                          onClick={() => setConfModalCamKey(cam.stream_key)}
                          style={hasModels ? styles.manageBtn : styles.manageBtnDisabled}
                          disabled={!hasModels}
                        >
                          설정
                        </button>

                        {/* 추론 ON/OFF */}
                        <span style={{ ...styles.toggleLabel, marginLeft: "0.8rem", fontSize: "0.85rem" }}>
                          추론
                        </span>
                        <SegmentedToggle
                          enabled={camEnabled}
                          onChange={(on) => toggleInference(cam.stream_key, on)}
                          disabled={!hasModels}
                        />
                      </div>
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
                );
              })}
            </tbody>
          </table>

          {/* 모달 — 카메라별 모델 관리 */}
          {modalCamKey !== null && (
            <ModelManagerModal
              open={modalCamKey !== null}
              onClose={() => setModalCamKey(null)}
              cameraName={cams.find((c) => c.stream_key === modalCamKey)?.name ?? "카메라"}
              selected={modelsByCam[modalCamKey] ?? []}
              onSelectedChange={(list) => handleModelsChange(modalCamKey, list)}
            />
          )}

          {/* 모달 — 카메라별 모델 설정 (conf + classes + colors) */}
          {confModalCamKey !== null && (
            <ModelSettingsModal
              open={confModalCamKey !== null}
              onClose={() => setConfModalCamKey(null)}
              cameraName={cams.find((c) => c.stream_key === confModalCamKey)?.name ?? "카메라"}
              fallbackConf={confs[confModalCamKey] ?? DEFAULT_CONF}
              selectedModels={modelsByCam[confModalCamKey] ?? []}
              settings={modelSettingsByCam[confModalCamKey] ?? {}}
              onSettingsChange={(next) =>
                setModelSettingsByCam((prev) => ({ ...prev, [confModalCamKey]: next }))
              }
            />
          )}

          {/* 스트리밍 그리드 — v3.0: WebSocket(JPEG) 기반, bbox 포함 */}
          <div
            style={{
              ...styles.grid,
              gridTemplateColumns: `repeat(${columns}, 1fr)`,
            }}
          >
            {cams.map((cam) => (
              <IpcamFrame
                key={cam.id}
                streamKey={cam.stream_key}
                name={cam.name}
                inferenceActive={
                  (enabled[cam.stream_key] ?? true) &&
                  (modelsByCam[cam.stream_key]?.length ?? 0) > 0
                }
                settings={modelSettingsByCam[cam.stream_key]}
              />
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
  streamCard: {
    backgroundColor: "#16213e",
    borderRadius: "8px",
    padding: "0.5rem",
    overflow: "hidden",
  },
  camLabel: {
    margin: 0,
    marginBottom: "0.3rem",
    fontSize: "0.85rem",
    color: "#aaaaaa",
    display: "flex",
    alignItems: "center",
  },
  streamImg: {
    width: "100%",
    height: "auto",
    display: "block",
    borderRadius: "4px",
    backgroundColor: "#000",
  },
  fpsBadge: {
    display: "inline-block",
    marginLeft: "0.6rem",
    padding: "0.1rem 0.4rem",
    backgroundColor: "#0f3460",
    color: "#4ade80",
    fontSize: "0.7rem",
    fontFamily: "monospace",
    borderRadius: "3px",
    verticalAlign: "middle",
  },
  toggleRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginTop: "0.4rem",
    flexWrap: "wrap",
  },
  toggleLabel: {
    fontSize: "0.75rem",
    color: "#aaaaaa",
  },
  modelBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    borderRadius: "50%",
    backgroundColor: "#4caf50",
    color: "#ffffff",
    fontSize: "0.78rem",
    fontWeight: 700,
    lineHeight: 1,
  },
  modelCount: {
    fontSize: "0.85rem",
    color: "#ffffff",
    padding: "0.4rem 0.9rem",
    backgroundColor: "#16213e",
    border: "1px solid #2a2a3e",
    borderRadius: "6px",
    minWidth: "150px",
    textAlign: "center",
    display: "inline-block",
  },
  manageBtn: {
    padding: "0.4rem 0.9rem",
    borderRadius: "6px",
    border: "1px solid #4caf50",
    backgroundColor: "transparent",
    color: "#4ade80",
    fontSize: "0.8rem",
    cursor: "pointer",
    fontWeight: 600,
  },
  manageBtnDisabled: {
    padding: "0.4rem 0.9rem",
    borderRadius: "6px",
    border: "1px solid #444",
    backgroundColor: "transparent",
    color: "#666",
    fontSize: "0.8rem",
    cursor: "not-allowed",
    fontWeight: 600,
  },
};

export default IpcamPage;
