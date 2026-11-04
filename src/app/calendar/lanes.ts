/** Zeitspanne eines Eintrags in Minuten seit Mitternacht */
export interface TimeSpan {
  startMinutes: number;
  durationMinutes: number;
}

/** Eintrag mit seiner Spur (`lane`) und der Zahl der Spuren in seiner Überschneidungsgruppe (`lanes`) */
export type WithLane<T> = T & { lane: number; lanes: number };

/**
 * Verteilt sich überschneidende Einträge nebeneinander: Jeder bekommt die erste freie Spur; alle Einträge einer
 * zusammenhängenden Überschneidung teilen sich die Breite durch dieselbe Zahl Spuren. Für Kalender und Tagesplan-PDF.
 */
export function withLanes<T extends TimeSpan>(entries: T[]): WithLane<T>[] {
  const sorted = [...entries].sort((a, b) => a.startMinutes - b.startMinutes);
  const blocks: WithLane<T>[] = [];
  let cluster: WithLane<T>[] = [];
  let clusterEnd = -1;
  const closeCluster = () => {
    const lanes = Math.max(1, ...cluster.map((b) => b.lane + 1));
    cluster.forEach((b) => (b.lanes = lanes));
    cluster = [];
  };
  for (const entry of sorted) {
    if (entry.startMinutes >= clusterEnd) closeCluster();
    const laneEnds = new Map<number, number>();
    for (const b of cluster) laneEnds.set(b.lane, Math.max(laneEnds.get(b.lane) ?? 0, b.startMinutes + b.durationMinutes));
    let lane = 0;
    while ((laneEnds.get(lane) ?? -1) > entry.startMinutes) lane++;
    const block = { ...entry, lane, lanes: 1 };
    cluster.push(block);
    blocks.push(block);
    clusterEnd = Math.max(clusterEnd, entry.startMinutes + entry.durationMinutes);
  }
  closeCluster();
  return blocks;
}
