declare const __httpUrl: unique symbol;
export type HttpUrl = string & { readonly [__httpUrl]: 'HttpUrl' };
