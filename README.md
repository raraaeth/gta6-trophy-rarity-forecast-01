# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/raraaeth/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/raraaeth/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A forecaster for the earn rate of every Grand Theft Auto VI PlayStation 5 trophy on Exophase — the percent of tracked players who hold each trophy — one week after launch. The program reads a case file (every read the house made of the game's trophy page before the checkpoint) and writes, for each of the 55 trophies, the 5%, 25%, 50%, 75% and 95% quantiles of its earn rate at the case's target, scored by pinball loss on the logit scale.

## How the forecast works

A printed rate is a ratio, earners / players tracked, and the two sides move for different reasons, so the program forecasts them separately and divides at the end:

- **Refresh snapshots.** Exophase refreshes its counts on its own schedule, so consecutive reads are often identical. The history is deduped into the distinct page states; only those carry information.
- **Players tracked.** ln N is fitted against ln(1 + hours since launch) — power-law growth, weighted toward recent snapshots — and extrapolated to the target. With a single frozen snapshot there is no trend, so a launch-week prior takes over: the pool is assumed to multiply over the horizon (on launch night the first refresh alone took it from 638 to 3,868), which shades every median rate down for the coming dilution.
- **Earners per trophy.** Earners are reconstructed as rate/100 × players tracked at each snapshot, ln(1 + earners) is fitted on the same log-time axis and extrapolated, never below the last observed count (earners cannot fall) and never above the forecast pool. A trophy nobody has earned yet gets a small tier-based prior instead of a hard zero; a saturated trophy (rate ≥ 99.9) is held at its rate with a tight band, since its earners grow with the pool by definition.
- **Spread.** Quantiles are normal z values around the median on the logit scale. The sigma combines the random-walk term 0.5·√(horizon days), the scatter of the two fits, and a floor that shrinks as the number of distinct snapshots grows — a frozen or short history earns a much wider band, because the next refresh and its dilution are exactly what a flat history cannot show.

The program is one file, `main.ts`, Node 22 standard library only, no network, fully deterministic.

## Run it

Put the case files (`*.in`) in a directory named `input`, then:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

One `<case id>.out` file is written per case.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ainur-irawan&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
