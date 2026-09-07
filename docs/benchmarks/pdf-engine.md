# PDF engine migration benchmark

## Decision

**Accept `@cantoo/pdf-lib` 2.9.1 as the `@easydoc/pdf-tools` implementation.**

The migration is primarily a maintenance and isolation change, not a performance optimization. Existing PDF regression tests remain green, mobile application code no longer imports a PDF engine directly, and the benchmark below does not show a material elapsed-time or practical output-size regression.

## Environment

- date: 2026-09-07
- runtime: Node.js 22.23.2
- host: Linux aarch64 DevSpace
- previous engine: `pdf-lib` 1.17.1
- candidate engine: `@cantoo/pdf-lib` 2.9.1
- runs per normal-PDF case: 9
- runs for image-PDF case: 7
- reported timing: median
- memory metric: sampled RSS delta after load/copy/save phases; this is not a true continuous peak-memory trace

## Workload

Each timed run performs the same operation:

1. load an existing PDF
2. create a new PDF
3. copy every source page
4. save with object streams enabled

Normal-PDF inputs are synthetic A4 documents containing text and vector drawing commands. The image-PDF input contains ten A4 pages backed by separately embedded 1200 × 1600 JPEG images. No user documents are used.

## Results

| Input | Engine | Median elapsed | Output size | Sampled RSS delta |
|---|---|---:|---:|---:|
| 10-page normal, 5.2 KB input | `pdf-lib` 1.17.1 | 9.29 ms | 3.27 KB | 0.50 MiB |
| 10-page normal, 5.2 KB input | `@cantoo/pdf-lib` 2.9.1 | 8.50 ms | 5.17 KB | 0.50 MiB |
| 50-page normal, 23.2 KB input | `pdf-lib` 1.17.1 | 29.50 ms | 13.88 KB | 1.38 MiB |
| 50-page normal, 23.2 KB input | `@cantoo/pdf-lib` 2.9.1 | 30.09 ms | 23.25 KB | 1.30 MiB |
| 100-page normal, 46.1 KB input | `pdf-lib` 1.17.1 | 54.38 ms | 27.15 KB | 1.80 MiB |
| 100-page normal, 46.1 KB input | `@cantoo/pdf-lib` 2.9.1 | 54.14 ms | 46.05 KB | 2.04 MiB |
| 10-page image, 12.95 MB input | `pdf-lib` 1.17.1 | 63.12 ms | 12.949 MB | 0.98 MiB |
| 10-page image, 12.95 MB input | `@cantoo/pdf-lib` 2.9.1 | 64.49 ms | 12.951 MB | 0.08 MiB |

## Interpretation

Elapsed time is effectively equivalent for the representative normal documents. At 50 pages the candidate is about 2% slower; at 100 pages it is slightly faster. The 10-page image case is about 2.2% slower.

The tiny synthetic normal PDFs show a large percentage increase in serialized size because the absolute documents are only a few tens of kilobytes. The largest absolute delta in that set is about 19 KB for the 100-page document. This does not carry over to the image-heavy case: for a roughly 12.95 MB PDF, the output-size delta is only about 1.8 KB.

The sampled RSS numbers are too coarse to treat small differences as meaningful. No repeatable memory failure occurred.

## Compatibility evidence

Automated regression coverage verifies:

- merge preserves all pages
- split creates valid one-page PDFs
- reorder/delete preserves requested page order
- rotation metadata applies only to selected pages
- JPEG and PNG image inputs produce readable A4 PDFs
- saved output can be loaded again
- full repository verification remains green

## Rollback

The application depends only on `@easydoc/pdf-tools`. If a later document-specific compatibility issue appears, rollback is limited to the package implementation/dependency and does not require changes to mobile UI, transfer code, or persisted document metadata.
