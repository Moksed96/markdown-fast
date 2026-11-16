# markdown-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Moksed96/markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Moksed96/markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free drop-in replacement for marked 18.1.3 — my entry in make.fun's "Make Markdown rendering faster" bounty. `parse.js` renders Markdown to exactly the HTML `marked.parse` returns with marked's default options (GFM on, breaks off), for every CommonMark 0.31.2 and GFM 0.29 spec example plus long generated READMEs, byte for byte. `main.ts` is the driver: it reads every case from `/input/cases.json`, renders each one alone with `parse`, and writes `/output/html.json`.

The renderer is written from scratch: a single-pass block parser and inline parser with array-based string building, minimal regex use, and cheap hot paths, so it runs faster than marked itself on the same set.

## Run it

```sh
node main.ts
```

It reads `/input/cases.json` and writes `/output/html.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=469bxynt&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
