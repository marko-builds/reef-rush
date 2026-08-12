// audio.js — NO-OP audio bus for the playable-ad build.
//
// Playable ads run muted, so the synthesized WebAudio bus + mp3 event sounds
// were dropped by the asset diet (no AudioContext, no audio files, no network).
// The class keeps the exact call surface main.js drives so the game flow code
// stays untouched; every method is an inert stub.

export class AudioBus {
  constructor() {
    this.muted = true;
  }

  resume() {}
  startAmbient() {}
  setMute() {}
  toggleMute() { return this.muted; }

  onLaunch() {}
  onPop() {}
  onPark() {}
  onVacate() {}
  onWin() {}
  onLose() {}
  onMineBoom() {}
  onDewrap() {}
  onGoldenLaunch() {}
  onGoldenPierce() {}
  onLevelClear() {}
  onTreasure() {}

  dispose() {}
}
