# cs_igl_harness

An LLM as the in-game leader (IGL) of the CT side in a simulated CS round.

You watch a 5v5 round play out on a top-down minimap. The T side runs a scripted play: a rush, a split or a fake. The LLM never sees the Ts. It only gets what its team could see or hear (footsteps, flashes, deaths) plus notes on how the Ts played earlier rounds. With that, it moves the five CTs and explains each call on the side of the screen. The game pauses after every call so you can read what it decided.

## Run

Needs Node 18+ and an [ai&](https://aiand.com) API key.

```sh
cp .env.example .env   # add your key
npm start              # open http://localhost:8787
```

Built in one evening at the +81 Builders Agent Harness Build Night, Tokyo.
