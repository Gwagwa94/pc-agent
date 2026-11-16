import { state } from './state.js';

export function addLog(msg: string): void {
  console.log(msg);
  const time = new Date().toLocaleTimeString('fr-FR');
  state.recentLogs.push(`[${time}] ${msg}`);
  if (state.recentLogs.length > 100) state.recentLogs.shift();
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
