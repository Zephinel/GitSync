// This former continuation fragment is intentionally syntactically complete.
// `include!` targets cannot close delimiters opened by another included file.
// The staging operation now lives entirely in part1; keep this file as a valid
// zero-behavior item so the existing overlay include order stays stable.
const _: () = ();
