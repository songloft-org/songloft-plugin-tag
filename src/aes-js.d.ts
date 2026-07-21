// aes-js 无官方类型声明，此处仅声明本项目用到的最小接口
declare module 'aes-js' {
  export const ModeOfOperation: {
    ecb: new (key: Uint8Array | number[]) => {
      encrypt(data: Uint8Array): Uint8Array;
      decrypt(data: Uint8Array): Uint8Array;
    };
  };
  export const utils: {
    utf8: { toBytes(s: string): Uint8Array; fromBytes(b: Uint8Array): string };
    hex: { toBytes(s: string): Uint8Array; fromBytes(b: Uint8Array): string };
  };
}
