// ABOUTME: Shared fake SSH child process used by pi-remote lifecycle and connection tests.
// ABOUTME: Emits stdio streams and close/error events without running a real ssh client.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}
