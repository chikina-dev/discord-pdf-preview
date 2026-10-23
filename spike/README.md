# PDF → PNG の workerd 検証

2026-10-23、macOS / Apple M4 / arm64 / Node.js 26.12.1 で実行。
Discord Bot 本体の実装ではなく、指定された2ライブラリの技術検証。

## 結果

- `@hyzyla/pdfium` 3.0.0 と `@cf-wasm/png` 0.4.0 を、ローカル workerd で併用できた。
- 3種類の合成 PDF をすべて 847×1200 の PNG に変換できた。PNG のデコード、寸法、2ページ目を使っていないことを検査し、文字 PDF の生成画像も目視した。
- Queue イベントから同じ変換処理を実行し、正常終了と明示的 ACK を確認した。実際のクラウド Queue を通した配送・再試行の検証ではない。
- 画像 PDF の追加20回の逐次処理が成功。WASM メモリの確保量は PDFium 約40.8 MiB、PNG 約23.3 MiBで一定だった。
- Wrangler の dry-run と TypeScript の型検査に成功。バンドルは非圧縮約5.5 MiB、gzip 約2.5 MiB。

検証後の設計セッションで、Bot のプレビューは縦横比を保ち、長辺を最大1200 pxとする方針に合意した。

| 入力 | PDF サイズ | PNG サイズ | 初期化後のローカル経過時間（2回） |
|---|---:|---:|---:|
| 文字・図形、2ページ | 約1.6 KiB | 約160 KiB | 19.8–21.0 ms |
| 線1万本 | 約166 KiB | 約3.18 MiB | 477–845 ms |
| 1600×2200画像を含む1ページ | 約6.02 MiB | 約1.32 MiB | 104–106 ms |

文字 PDF の最初の変換は PDFium 初期化込みで約98 ms。
画像には実文書や個人情報を使わず、すべて生成したテスト素材を使った。
複雑な図形の測定値には実行ごとのばらつきがある。

## 検証範囲の限界

**Free プランで動くことを確定する検証は、まだ完了していない。**

ローカルの経過時間と V8 CPU プロファイルは Cloudflare が計上する CPU 時間ではない。
ローカル Miniflare は Free の CPU・メモリ制限を再現して合否を判定する仕組みとして使っていない。

WASM 合計約64.1 MiBは確保された線形メモリだけであり、isolate 全体のピーク使用量ではない。
20回の逐次処理では Inspector の JavaScript ヒープ使用量は最大約2.84 MiB、
`backingStorageSize` は約13.3–63.4 MiBの間を変動した。
これらの統計と WASM の値の重複・計上範囲を確認できていないため、単純加算をピーク使用量として扱わない。
診断のための強制 GC は使っていない。

大きな PDF、多数の画像、日本語フォント、パスワード付き PDF、破損 PDF、複数 PDF の同時処理は未検証。
特に複数枚の PNG を返信用に保持すると追加メモリが必要になる。
入力ファイルサイズだけでは、内部画像の展開サイズや描画負荷は制限できない。
設計セッションでは Bot 独自の入力 PDF サイズ上限は設けず、Discord に添付された PDF を対象にする方針に合意した。
長辺1200 pxの描画と逐次処理を基本とし、出力の送信には Discord 側の制限への対応が残る。

次の検証は、合意した対象 PDF と出力解像度でのクラウド Queue Consumer 実行。
Paid アカウントでの成功だけでは、Free プランの制限内で動く証明にはならない。
今回、クラウドへのデプロイ、Discord への送信は行っていない。

## 再実行

```sh
npm ci
npm run spike
npm run typecheck
```

`npm run spike` はローカル workerd と Inspector 用の localhost ポートを開く。
Wrangler の dry-run だけを使い、クラウド資源は作らない。
`spike/output/` に入力 PDF、出力 PNG、CPU プロファイル、`results.json` が保存される。

使用バージョンは lockfile に記録している。
Miniflare は Wrangler 4.152.0 と揃えて `5.20261019.2-beta` を使用し、
workerd は `1.20261019.1`、compatibility date は `2026-10-23`。
単体 Miniflare の当時の latest（4.20260730.0）は、その日付をサポートしていなかった。
ベータ版 Miniflare の設定変換には、パッケージが提供する `convertV4MiniflareOptions` を使っている。

## WASM の組み込み

PDFium の `.wasm` を静的 import し、`PDFiumLibrary.init({ instantiateWasm })` で
`new WebAssembly.Instance(module, imports)` を渡す。
PNG は `@cf-wasm/png/workerd` を使う。
ライブラリのソース変更や WASM の動的コンパイルは不要だった。

`worker.ts` の HTTP 入口はローカル測定専用。そこにある20 MiBの受信チェックは検証用コードのもので、Bot 本体の仕様には採用しない。
Queue のテストでは小さな PDF を本文に含めてイベントを直接呼び出しているが、
Bot 本体では Queue に添付 URL・メッセージ ID・投稿時刻などを渡し、PDF バイナリは入れない。

## 公式資料との対応

- [DO 料金](https://developers.cloudflare.com/durable-objects/platform/pricing/): 1個を24時間稼働すると `0.128 × 86,400 = 11,059.2 GB-s/日`。Free の13,000 GB-s/日以内。他の使用量や重複稼働を除く概算。
- [Queues 制限](https://developers.cloudflare.com/queues/platform/limits/): Free にも適用される Consumer の既定 CPU 時間は30秒。HTTP の10 msとは区別する。
- [Workers 制限](https://developers.cloudflare.com/workers/platform/limits/): isolate のメモリ上限128 MBは Paid でも共通。
- [Queues 料金](https://developers.cloudflare.com/queues/platform/pricing/): Free は10,000操作/日。通常の1メッセージ配送は書込・読込・削除で3操作、再試行は追加読込。
