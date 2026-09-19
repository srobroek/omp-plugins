import { performance } from "node:perf_hooks";
import { bootstrapAllowed } from "../worktrunk/extensions/worktree-gate.ts";

const corpus = Array.from({ length: 500 }, (_, i) =>
	i % 4 === 0 ? "pwd" : i % 4 === 1 ? "git status --short" : i % 4 === 2 ? "bd list" : "rm -f scratch",
);
const samples: number[] = [];
for (const command of corpus) {
	const start = performance.now();
	bootstrapAllowed(command);
	samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const percentile = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] ?? 0;
console.log(JSON.stringify({ n: samples.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: samples.at(-1) ?? 0 }));
