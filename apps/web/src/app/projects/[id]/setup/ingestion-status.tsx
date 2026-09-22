"use client";

import { useEffect, useState } from "react";

type Health = {
  totalEvents: number;
  lastEventAt: string | null;
  eventNamesSeen: string[];
  orphanSessions: number;
};

function formatAge(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}

export function IngestionStatus({ projectId, expectedCount }: { projectId: string; expectedCount: number }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/projects/${projectId}/ingestion`, { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setError("暂时读不到接入状态。");
          return;
        }
        const body = (await response.json()) as Health;
        if (!cancelled) {
          setHealth(body);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("暂时读不到接入状态。");
      }
    }
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId]);

  if (error) return <p className="error">{error}</p>;
  if (!health) return <p className="muted">正在检查事件…</p>;
  if (health.totalEvents === 0) return <p className="banner">等待第一个事件…</p>;

  const seen = health.eventNamesSeen.join("、");
  return (
    <div className="card">
      <p className="banner">已接入。最近事件 {health.lastEventAt ? formatAge(health.lastEventAt) : "刚刚"}。</p>
      <p>
        接入检查：已见到 {health.eventNamesSeen.length}/{expectedCount} 种事件
        {seen ? `（${seen}）` : ""}
      </p>
      <p className="muted">孤儿 session：{health.orphanSessions}。没有先发送 paywall_viewed 的事件会记在这里，不进入漏斗。</p>
    </div>
  );
}
