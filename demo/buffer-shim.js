// Browser stand-in for Node's Buffer, covering only the surface the bundled
// composer actually touches: utf8/base64 conversion for MIME bodies and RFC
// 2047 encoded-words. Extending Uint8Array gives length, subarray and
// byte indexing for free.
class BufferShim extends Uint8Array {
  static from(value, encoding) {
    if (typeof value !== 'string') return new BufferShim(value);
    switch (encoding) {
      case 'base64':
      case 'base64url': {
        let s = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
        while (s.length % 4) s += '=';
        const bin = atob(s);
        const out = new BufferShim(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      case 'binary':
      case 'latin1': {
        const out = new BufferShim(value.length);
        for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
        return out;
      }
      default:
        return new BufferShim(new TextEncoder().encode(value));
    }
  }

  static alloc(size) { return new BufferShim(size); }
  static isBuffer(v) { return v instanceof BufferShim; }

  static concat(list) {
    const total = list.reduce((n, b) => n + b.length, 0);
    const out = new BufferShim(total);
    let offset = 0;
    for (const b of list) { out.set(b, offset); offset += b.length; }
    return out;
  }

  static compare(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  toString(encoding) {
    switch (encoding) {
      case 'base64':
      case 'base64url': {
        let bin = '';
        for (let i = 0; i < this.length; i++) bin += String.fromCharCode(this[i]);
        const b64 = btoa(bin);
        return encoding === 'base64url'
          ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
          : b64;
      }
      case 'hex': {
        let out = '';
        for (let i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, '0');
        return out;
      }
      case 'latin1':
      case 'binary': {
        let out = '';
        for (let i = 0; i < this.length; i++) out += String.fromCharCode(this[i]);
        return out;
      }
      default:
        return new TextDecoder('utf-8').decode(this);
    }
  }
}

export { BufferShim as Buffer };
