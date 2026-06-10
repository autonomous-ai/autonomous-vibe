// Group each user prompt with the assistant turns that answer it so related
// messages keep their spacing as a unit in the history.
export function groupTurns(history) {
  const groups = [];
  for (const turn of history) {
    if (turn.role === "user" || groups.length === 0) {
      groups.push([turn]);
    } else {
      groups[groups.length - 1].push(turn);
    }
  }
  return groups;
}
