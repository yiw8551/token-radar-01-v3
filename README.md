[![Token Radar](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/yiw8551/token-radar-01-v3/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/yiw8551/token-radar-01-v3/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Launch Radar — token-radar-01

A token launch radar for the [make.fun token-radar-01 bounty](https://make.fun/bounty/token-radar-01): it ranks the 198 pre-token protocols in the snapshot by the implied value of a token they have not issued yet, and shows a reader how to farm each one.

## The model

Implied value = TVL × the median market-cap/TVL multiple of the tokenized protocols in the protocol's own category (the global median when its category holds fewer than three tokenized comparables) × a seven-day momentum factor × a small maturity factor for how long it has run with no token. Launch odds fall with no-token age. The board ranks pre-token protocols only — 40 from the snapshot's watchlist plus the 158 largest remaining pre-token protocols below the floor. Protocols whose token already trades are listed on the dashboard as reference only and are never ranked.

The multiples model is validated honestly: leave-one-out prediction of tokenized protocols' market caps is reported on the dashboard with its MAE and R², and every row carries an uncertainty interval from its category multiple's spread.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

`main.ts` (Node 22, standard library only) reads the snapshot and writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory. The three screenshots are programmatic renders of the dashboard's own views — the board, a protocol detail view and a filtered view — drawn from the same computed board, since no headless browser is available on the build machine. Two runs over the same snapshot write byte-identical outputs.
