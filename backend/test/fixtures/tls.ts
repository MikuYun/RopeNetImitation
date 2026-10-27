/**
 * SEC-01 测试用自签证书材料（**仅供本地测试，禁止用于任何真实部署**）。
 *
 * 为什么内联成 TS 常量而不是放 .pem 文件：
 * management/verify.mjs 把 backend 快照进临时目录后在那里跑 `node --test dist/test/*.test.js`，
 * 但它的文件白名单只收 ts/vue/mjs/json/html/css/md/svg/png/ico/webp/jpg/conf/service，
 * 且 management/ 不在本任务的写权限内。若证书以 .pem 落盘，快照里就没有这份材料，
 * 门禁里的 backend-tests 会在模块加载阶段直接失败。因此统一改成：
 * 「源码里内联 PEM → 测试运行时 materializeTls() 写进临时目录 → 用完即删」。
 *
 * 证书信息：CN=localhost，SAN = DNS:localhost, IP:127.0.0.1，
 * 有效期 2026-10-22 → 2036-10-19，2048-bit RSA。私钥无口令。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TLS_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUfOHGy1vihGuYfytd33kcbJY32XwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyMjAzMjA1MVoXDTM2MTAx
OTAzMjA1MVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA60GyFFJNgPag1je25vnOBzm00IaxeHvDR2e+jQiJD+Lg
XExXRMnUBTjeDWkidFirVMxfafeA1iYNMiGILkp666qV7nxadYMRHDoeX21VvfcK
DYVrOOwgvnt57Vz3JosLEC6wdUFxnYgymDXzjUpsu47TmeUSkRoslz/glNODkW2b
PXu+xnCuJTehoXPZxIz0MGeNDiZpwxbcmLM29XiyGWXqibjT3LLOKEKnqkpwZbAD
1umTw84oxk3pi13F4m0lFTHo/JnTjx07/tLclGH53U2klRNC4E0EDla0uiBvYvEc
LsHLKhGctlm+y47J3nBe5Yh3TKvCgmnz0lQrXJl+CwIDAQABo28wbTAdBgNVHQ4E
FgQUm1lA5h2zXJW1BeQyBFjaIy1GppIwHwYDVR0jBBgwFoAUm1lA5h2zXJW1BeQy
BFjaIy1GppIwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAEKlpiUrGf8w9bYZIuHp+fqGtUQYw7Zk
HsDA7DHlSKdpCLkSvMY2RYIlP95Vd2K7xW029+Z2eeTZUAkN0eBktPKaV6RrXKDb
XgzhIGlA85mez4B+Xy0DhC8gMO75FOxm1pbyeix+KWtKrMSu+uZyrstA+6Bw7vNf
DYDIRZ0jiAjdNCbu2ZXY/u6KRXilfOjZjQ64mUy3mR3VmucwsUnoLyZUMqUA+cV/
khFORcqbs2AnAdQE7RKSGZ92ncYdzgRxN57fjGVidWhHB6AgrM7QrIOCg+Q7QPPS
VzO355DHjvKYwsg2/XPZKgVwnmMydfq+RPHJR/tdCpZLHp9VQJq45I0=
-----END CERTIFICATE-----
`;

export const TLS_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDrQbIUUk2A9qDW
N7bm+c4HObTQhrF4e8NHZ76NCIkP4uBcTFdEydQFON4NaSJ0WKtUzF9p94DWJg0y
IYguSnrrqpXufFp1gxEcOh5fbVW99woNhWs47CC+e3ntXPcmiwsQLrB1QXGdiDKY
NfONSmy7jtOZ5RKRGiyXP+CU04ORbZs9e77GcK4lN6Ghc9nEjPQwZ40OJmnDFtyY
szb1eLIZZeqJuNPcss4oQqeqSnBlsAPW6ZPDzijGTemLXcXibSUVMej8mdOPHTv+
0tyUYfndTaSVE0LgTQQOVrS6IG9i8RwuwcsqEZy2Wb7LjsnecF7liHdMq8KCafPS
VCtcmX4LAgMBAAECggEAH3NKP0qRb0A0Au9dKvESXgeU6JuudhD1lkIu8zkaObQh
kl/npXE7QEd4nV+vaiZrITcBOnAKxUDpBV6o5Kddr3Zqp4CbB0KyXY0CKne6ErSd
Shl1WsgWczXxTY40Fu8CV54mRkateFs7iFBjcuwUL9l0PbVQuh0/ANQFTgrIzVQR
jPOiuegnnLWsILRcnRgKSw/8P20CHZEtJhQWXyn1y73nkmqDLcnjhFIG28N63KIb
ElD4Or45QrajlP0fgsZcsFjjx5H1d58iU3g/18ZZsmAYWxu+WYWgfd7H7gO4OtuZ
7WECSro8Pc8UrgR21Jix1zbrFGO3iGoZ4E0woD6MwQKBgQD327zHuUmNtfuNoj8T
bQuJxOoxm2ceCtjzTRp22mXwI8toH2r13Gtr0ga8GdByeGDCvbQNpxhuw9OlEOSw
1+H9iLS63RyFC/9pSFCtYEqALUcyQ/c/AkIrPlofyoGoG23MM4ITOze8348PTCUQ
qaGu+l+nzhGsz3OkYyD0G50yWQKBgQDy+/07JU0bOkpt9js0Ff8JogE2/+/pHfIY
dSE/88r3jmjlSLMTP9Qu2KmxHMcX1NqeloAOXEIijGVHhzEmL6fiC2kS1pXSEdhN
W56lA9XTRbFHuAlPpQvDFoYX+JdPhZRke/Y2XOUf7Oa9w3rhL628CZptELHQJz8E
1eJtNY4/AwKBgQCeupgxB5X1LOAGGitu01yaRAL+9diZwrShS3VxO/ggS6wN6GDl
Rt18VSp+98EoLbM5w6c1PxdEiCBYC3OJVRei+BNVwBhtk/tjfy47efj8EQMRS7lh
Hp8ldm7dASD7eWVdancYvcm6KSlC0K7D9v5WQn1Tx4JGOyyB0AHgknafMQKBgFzO
8wJMVQ85TISDsElMvYUoY95mE3SvA3FkC7cpnzS/KEGravrHPnxGNUp4+3KW0ooQ
YgkaJAieJ3ESqiszuKQWR6PyYndCaaPigs30kQ+JZxVFrgjFuaBiUgWF5gVxuCRJ
VNme0cVH7zo8GAs68tkHsfxGjCQ9WUy3hSzBb/uRAoGAVPAGqnayFHnwSgyS9SqW
TS5LzaOtAUXKkS5zE5MG1Nrmu/3bq1iSCquSvH3U30aEkvqYMhMK0wepq0GOpmxO
MbFME6CjiZGHdRkLtqaZPbHiJFRCers/iujQk7bhQLXeKY62SanJvCv61RZGHZ2e
VJtxdeSugn8IMvP1bavZAdM=
-----END PRIVATE KEY-----
`;

export interface MaterializedTls { directory: string; certPath: string; keyPath: string; dispose: () => void }

/** 把内联 PEM 落到独立临时目录，返回可直接喂给 loadTls/buildApp 的路径。 */
export function materializeTls(): MaterializedTls {
  const directory = mkdtempSync(join(tmpdir(), 'aitrance-tls-'));
  const certPath = join(directory, 'localhost-cert.pem');
  const keyPath = join(directory, 'localhost-key.pem');
  writeFileSync(certPath, TLS_CERT_PEM, 'utf8');
  writeFileSync(keyPath, TLS_KEY_PEM, 'utf8');
  return { directory, certPath, keyPath, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
