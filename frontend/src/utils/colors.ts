/**
 * 클래스별 bbox 기본 색상 — Ultralytics YOLO `Colors` 클래스 와 동일한 20색 팔레트.
 *
 * 같은 class_id 는 항상 같은 색을 받음 (deterministic). 사용자 override 가 있으면 그것을 사용.
 */

export const ULTRALYTICS_PALETTE: readonly string[] = [
  "#FF3838",
  "#FF9D97",
  "#FF701F",
  "#FFB21D",
  "#CFD231",
  "#48F90A",
  "#92CC17",
  "#3DDB86",
  "#1A9334",
  "#00D4BB",
  "#2C99A8",
  "#00C2FF",
  "#344593",
  "#6473FF",
  "#0018EC",
  "#8438FF",
  "#520085",
  "#CB38FF",
  "#FF95C8",
  "#FF37C7",
];

export function defaultClassColor(classId: number): string {
  const i = ((classId % ULTRALYTICS_PALETTE.length) + ULTRALYTICS_PALETTE.length) %
    ULTRALYTICS_PALETTE.length;
  return ULTRALYTICS_PALETTE[i];
}

export function resolveClassColor(
  classId: number,
  override?: Record<number, string>,
): string {
  if (override && classId in override) return override[classId];
  return defaultClassColor(classId);
}
