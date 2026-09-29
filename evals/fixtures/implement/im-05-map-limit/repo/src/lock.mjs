export const createLock = () => ({
  held: false,
  acquire() {
    if (this.held) throw new Error('lock already held');
    this.held = true;
  },
  release() {
    this.held = false;
  },
});
