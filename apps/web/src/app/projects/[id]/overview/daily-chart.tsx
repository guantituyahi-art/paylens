import type { Overview } from "@/lib/funnel";

export function DailyChart({ daily }: { daily: Overview["daily"] }) {
  const width = 640;
  const height = 200;
  const padLeft = 28;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 28;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;
  const maxSessions = Math.max(1, ...daily.map((day) => day.sessions));

  function x(index: number) {
    if (daily.length <= 1) return padLeft + innerWidth / 2;
    return padLeft + (index / (daily.length - 1)) * innerWidth;
  }

  function ySessions(value: number) {
    return padTop + innerHeight - (value / maxSessions) * innerHeight;
  }

  function yRate(value: number) {
    return padTop + innerHeight - value * innerHeight;
  }

  const sessionPoints = daily.map((day, index) => `${x(index)},${ySessions(day.sessions)}`).join(" ");
  const rateSegments: string[][] = [];
  let current: string[] = [];
  daily.forEach((day, index) => {
    if (day.overall === null) {
      if (current.length > 0) rateSegments.push(current);
      current = [];
      return;
    }
    current.push(`${x(index)},${yRate(day.overall)}`);
  });
  if (current.length > 0) rateSegments.push(current);

  return (
    <figure className="card chart-card">
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日 Paywall 展示次数和整体转化率">
        <polyline fill="none" stroke="#1c1917" strokeWidth="2" points={sessionPoints} />
        {rateSegments.map((points, index) => (
          <polyline key={index} fill="none" stroke="#0f766e" strokeWidth="2" points={points.join(" ")} />
        ))}
        {daily.map((day, index) =>
          day.partial ? <circle key={day.date} cx={x(index)} cy={ySessions(day.sessions)} r="4" fill="#b45309" /> : null,
        )}
        <text x={padLeft} y={height - 8} fontSize="12" fill="#78716c">
          {daily[0]?.date.slice(5)}
        </text>
        {daily.length > 1 ? (
          <text x={width - padRight} y={height - 8} fontSize="12" fill="#78716c" textAnchor="end">
            {daily[daily.length - 1]?.date.slice(5)}
          </text>
        ) : null}
      </svg>
      <p className="muted">
        黑线是每天的展示次数，绿线是整体转化率。
        {daily.some((day) => day.partial) ? "橙色点是今天，这一天的数据还不完整。" : ""}
      </p>
    </figure>
  );
}
