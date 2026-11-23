/** Referencias a estados inmutables. Un gesto puede producir varias actualizaciones. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private group: symbol | undefined;

  record(previous: T, group?: symbol) {
    if (!group || group !== this.group) {
      this.past.push(previous);
      if (this.past.length > 100) this.past.shift();
    }
    this.future = [];
    this.group = group;
  }

  undo(current: T): T | undefined {
    this.group = undefined;
    const previous = this.past.pop();
    if (previous !== undefined) this.future.push(current);
    return previous;
  }

  redo(current: T): T | undefined {
    this.group = undefined;
    const next = this.future.pop();
    if (next !== undefined) this.past.push(current);
    return next;
  }
}
