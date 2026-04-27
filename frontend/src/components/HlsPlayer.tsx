import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

const HLS_PORT = import.meta.env.VITE_HLS_PORT;
const HLS_BASE = `http://${window.location.hostname}:${HLS_PORT}`;

interface HlsPlayerProps {
  streamKey: string;
  name: string;
}

function HlsPlayer({ streamKey, name }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<"connecting" | "playing" | "error">("connecting");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const hlsUrl = `${HLS_BASE}/${streamKey}/index.m3u8`;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        maxBufferLength: 30,
        maxMaxBufferLength: 600,
        maxBufferSize: 60 * 1024 * 1024,
        maxBufferHole: 0.5,
        manifestLoadingTimeOut: 20000,
        levelLoadingTimeOut: 20000,
        fragLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 6,
      });

      hlsRef.current = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        setStatus("playing");
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;

        setStatus("error");

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // 네트워크 오류 → 3초 후 재시도
            setTimeout(() => {
              hls.startLoad();
              setStatus("connecting");
            }, 3000);
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            setStatus("connecting");
            break;
          default:
            // 치명적 오류 → 5초 후 재초기화
            setTimeout(() => {
              hls.destroy();
              hlsRef.current = null;
              // 재연결은 useEffect cleanup → 재실행으로
              setStatus("connecting");
            }, 5000);
            break;
        }
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Safari 네이티브 HLS 지원
      video.src = hlsUrl;
      video.addEventListener("loadedmetadata", () => {
        video.play().catch(() => {});
        setStatus("playing");
      });
    }
  }, [streamKey]);

  return (
    <div style={styles.card}>
      <p style={styles.label}>
        {name}
        <span
          style={{
            marginLeft: "0.5rem",
            fontSize: "0.7rem",
            color:
              status === "playing"
                ? "#4ade80"
                : status === "connecting"
                  ? "#facc15"
                  : "#f87171",
          }}
        >
          {status === "playing"
            ? "● 스트리밍"
            : status === "connecting"
              ? "● 연결 중..."
              : "● 재연결 중..."}
        </span>
      </p>
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        style={styles.video}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    backgroundColor: "#0f3460",
    borderRadius: "8px",
    overflow: "hidden",
  },
  label: {
    margin: 0,
    padding: "0.4rem 0.6rem",
    fontSize: "0.8rem",
    backgroundColor: "#16213e",
  },
  video: {
    width: "100%",
    display: "block",
    aspectRatio: "16/9",
    objectFit: "cover",
    backgroundColor: "#000000",
  },
};

export default HlsPlayer;
