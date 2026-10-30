/** Fire-and-forget output port: push a value, get nothing back. */
export interface Sink<T> {
  emit(value: T): void;
}
