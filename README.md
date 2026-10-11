# AutoTool — Tự động đăng bài đa nền tảng

Tool tự động đăng bài lên **nhiều nền tảng**, **nhiều nhóm/trang** từ một danh sách bài viết + ảnh.
Có Web dashboard, lên lịch, hàng đợi, retry và báo cáo.

> **Điểm quan trọng nhất về an toàn:** tool **KHÔNG lưu mật khẩu**. Nó dùng trình duyệt thật
> (Edge/Chrome) và bạn đăng nhập thủ công một lần; phiên đăng nhập được lưu trong profile riêng
> của từng tài khoản.

---

## Mục lục

- [Tính năng](#tính-năng)
- [Cài đặt](#cài-đặt)
- [Bắt đầu trong 4 bước](#bắt-đầu-trong-4-bước)
- [Kiến trúc](#kiến-trúc)
- [Định dạng import](#định-dạng-import)
- [Chiến lược ghép bài × nhóm](#chiến-lược-ghép-bài--nhóm)
- [Cơ chế an toàn cho tài khoản](#cơ-chế-an-toàn-cho-tài-khoản)
- [Nền tảng hỗ trợ](#nền-tảng-hỗ-trợ)
- [Khi selector bị lệch](#khi-selector-bị-lệch)
- [API](#api)
- [Kiểm thử](#kiểm-thử)
- [Sử dụng có trách nhiệm](#sử-dụng-có-trách-nhiệm)

---

## Tính năng

| Nhóm | Chi tiết |
|---|---|
| **Đa nền tảng** | Facebook (Page + Group), LinkedIn (profile/group/company), X, Telegram, Reddit, Instagram, Threads, TikTok, Zalo |
| **Đa tài khoản** | Mỗi tài khoản một browser profile riêng, giới hạn và nhịp đăng riêng |
| **Danh sách nhóm** | Import hàng loạt từ URL, tự nhận diện loại + ID |
| **Danh sách bài** | Import nhiều bài một lần, mỗi bài có ảnh/video/link/hashtag riêng |
| **Thư viện media** | Upload một lần, dùng cho nhiều bài |
| **Lên lịch + hàng đợi** | Hẹn giờ bắt đầu, worker tự xử lý tuần tự theo từng tài khoản |
| **Retry thông minh** | Backoff lũy tiến, nhận biết rate-limit để nghỉ dài, dừng khi hết phiên đăng nhập |
| **Báo cáo** | Theo ngày / nền tảng / tài khoản / chiến dịch, top lỗi, ảnh chụp màn hình lúc lỗi |
| **Chế độ thử (dry-run)** | Điền nội dung + đính ảnh như thật nhưng **không bấm nút Đăng** |

---

## Cài đặt

**Yêu cầu:** Node.js ≥ 22.5 (dùng `node:sqlite` có sẵn, không cần module native),
và Chrome hoặc Edge đã cài (để không phải tải Chromium ~130MB).

```bash
cd F:\AutoTool
npm install
copy .env.example .env
npm run doctor      # kiểm tra môi trường
npm start
```

Mở **http://127.0.0.1:8787**

> Trên Windows, nếu PowerShell chặn `npm` do Execution Policy, dùng `npm.cmd` thay vì `npm`.

---

## Bắt đầu trong 4 bước

1. **Tài khoản** → `+ Thêm tài khoản` → chọn nền tảng, đặt tên gợi nhớ.
2. Bấm **Đăng nhập** → cửa sổ trình duyệt mở ra → đăng nhập thủ công (kể cả 2FA)
   → bấm **Kiểm tra** để xác nhận phiên còn hiệu lực.
3. **Nhóm & Trang** → `📥 Import danh sách` → dán danh sách URL, mỗi dòng một nhóm.
4. **Bài viết** → tạo/import bài + ảnh → **Chiến dịch** → chọn bài × nhóm → tạo.

> ⚠️ **Luôn chạy "Chế độ thử" trước** với một nhóm duy nhất. Tool sẽ mở trình duyệt, điền nội dung
> và đính ảnh y như thật nhưng dừng trước nút Đăng. Xem **Nhật ký** (lọc `debug`) để biết bước nào lỗi.

---

## Kiến trúc

```
src/
├── index.js              # khởi động server + worker, tắt gọn gàng
├── config.js             # đọc .env, đường dẫn, mặc định
├── db.js                 # node:sqlite - schema + helper (WAL, transaction)
├── logger.js             # log ra console + file + DB
├── cli.js                # doctor / platforms / stats / reset
│
├── core/
│   ├── locator.js        # phân giải selector nhiều lớp dự phòng
│   ├── flow.js           # ENGINE: chạy các bước khai báo, template, dry-run
│   ├── browser.js        # quản lý browser profile theo tài khoản, kiểm tra phiên
│   ├── runner.js         # thực thi 1 lượt đăng (1 bài → 1 nhóm)
│   └── worker.js         # hàng đợi: lịch, rate-limit, retry, giới hạn ngày
│
├── platforms/            # MỖI NỀN TẢNG = 1 FILE KHAI BÁO, không có logic riêng
│   ├── _shared.js  facebook.js  linkedin.js  x.js  telegram.js
│   └── reddit.js  instagram.js  threads.js  tiktok.js  zalo.js  index.js
│
├── server/
│   ├── http.js           # express app, xử lý lỗi, static
│   └── routes/           # core.js (health/stats/logs) · accounts.js · content.js · jobs.js
│
└── web/                  # dashboard: HTML + CSS + ES modules (KHÔNG cần build step)
```

### Luồng dữ liệu

```
posts × targets  ──►  job_items (hàng đợi)  ──►  worker  ──►  runner  ──►  flow  ──►  browser
                          ▲                        │
                          └──── retry / hoãn ──────┘
```

### Bảng dữ liệu

| Bảng | Vai trò |
|---|---|
| `accounts` | Tài khoản: nền tảng, profile dir, giới hạn ngày, nhịp nghỉ, trạng thái phiên |
| `targets` | Nhóm/trang/kênh thuộc một tài khoản: loại, ID, URL, bật/tắt |
| `posts` | Bài viết: tiêu đề, nội dung, link, hashtag, danh sách media |
| `jobs` | Chiến dịch: chiến lược, lịch, dry-run, bộ đếm tiến độ |
| `job_items` | **Hàng đợi**: mỗi dòng = 1 bài × 1 nhóm, có `run_at`, `attempts`, `error` |
| `logs` | Nhật ký có cấu trúc, tự xoá sau 14 ngày |

---

## Định dạng import

### Nhóm / Trang

```
https://www.facebook.com/groups/123456789
https://www.facebook.com/groups/123456789 | Nhóm Mua Bán Đồ Cũ
Nhóm Mua Bán Đồ Cũ | https://www.facebook.com/groups/123456789
@tenkenh                                   # Telegram
https://www.reddit.com/r/banhang
# dòng bắt đầu bằng # sẽ bị bỏ qua
```

### Bài viết

Các bài cách nhau bằng một dòng `---`:

```
Tiêu đề: Khuyến mãi tháng 12
Link: https://example.com/sale
Ảnh: 1700000-abc-anh1.jpg, 1700000-def-anh2.jpg
#khuyenmai #sale

Nội dung chi tiết của bài viết…
---
Tiêu đề: Bài thứ hai
Nội dung bài thứ hai…
```

Tên file trong dòng `Ảnh:` là tên file đã upload trong thư viện media.

---

## Chiến lược ghép bài × nhóm

Giả sử có **3 bài** và **10 nhóm**:

| Chiến lược | Kết quả | Khi nào dùng |
|---|---|---|
| **Mỗi bài → mọi nhóm** | 30 lượt đăng | Muốn phủ tối đa |
| **Chia đều, xoay vòng** | 30 lượt, mỗi nhóm nhận 3 bài **khác nhau** | Muốn mỗi nhóm thấy nội dung đa dạng |
| **Ghép 1-1 theo thứ tự** | 3 lượt đăng | Mỗi nhóm một bài riêng |

---

## Cơ chế an toàn cho tài khoản

Các giới hạn này **được bật mặc định và nên giữ nguyên** — chúng bảo vệ tài khoản của bạn:

| Cơ chế | Mặc định | Ở đâu |
|---|---|---|
| Nghỉ ngẫu nhiên giữa 2 bài của cùng tài khoản | 120–360 giây | `accounts.min_delay_sec` / `max_delay_sec` |
| Giới hạn bài mỗi ngày mỗi tài khoản | 15 | `accounts.daily_limit` |
| Mỗi tài khoản chỉ chạy **1 lượt đăng tại một thời điểm** | luôn bật | `worker.js` |
| Lệch thời điểm bắt đầu giữa các tài khoản | 5–45 giây | `jobs.js` |
| Nghỉ dài khi bị rate-limit | 15–45 phút | `worker.js` |
| Backoff khi lỗi | 1, 2, 4… phút (tối đa 30) | `worker.js` |
| Tự dừng chiến dịch khi hết phiên đăng nhập | luôn bật | `worker.js` |

Thêm nữa:

- **Không lưu mật khẩu.** Chỉ giữ profile trình duyệt đã đăng nhập trong `data/profiles/`.
  Hãy bảo vệ thư mục `data/` như bảo vệ mật khẩu.
- **Không có captcha bypass, không xoay proxy, không tạo tài khoản hàng loạt.**
- **Chế độ thử (dry-run)** để kiểm tra mà không đăng gì.

---

## Nền tảng hỗ trợ

| Nền tảng | Trạng thái | Hỗ trợ |
|---|---|---|
| **Facebook** | Chưa kiểm chứng | Page, Group, Profile |
| **LinkedIn** | Chưa kiểm chứng | Profile, Group, Company |
| **X (Twitter)** | Chưa kiểm chứng | Profile (280 ký tự) |
| **Telegram** | Chưa kiểm chứng | Group, Channel, Chat |
| **Reddit** | Chưa kiểm chứng | Subreddit, Profile |
| **Instagram** | ⚠️ Thử nghiệm | Profile (bắt buộc có ảnh) |
| **Threads** | ⚠️ Thử nghiệm | Profile (500 ký tự) |
| **TikTok** | ⚠️ Thử nghiệm | Profile (bắt buộc có video) |
| **Zalo** | ⚠️ Thử nghiệm | Nhóm, Chat |

**"Chưa kiểm chứng"** nghĩa là flow đã viết theo giao diện hiện tại nhưng chưa được chạy thật
thành công trên tài khoản thật. Giao diện các nền tảng thay đổi liên tục — hãy chạy **chế độ thử**
với một nhóm trước, rồi cập nhật selector nếu cần.

---

## Khi selector bị lệch

1. Chạy **chế độ thử** với `HEADLESS=false` trong `.env` để xem trình duyệt thao tác.
2. Mở **Nhật ký**, lọc mức `debug` → tìm bước thất bại (có ghi `#<số> <hành động>`).
3. Sửa selector trong `src/platforms/<nền tảng>.js`. Mỗi selector là **mảng nhiều phương án** —
   chỉ cần thêm phương án mới vào đầu mảng:

```js
{
  click: [
    'div[role="dialog"] div[aria-label="Đăng"][role="button"]',  // ← thêm dòng này
    { role: 'button', name: /^(Post|Đăng)$/ },
  ],
  submit: true,   // bước bấm Đăng → tự động bị bỏ qua ở chế độ thử
}
```

Các dạng selector được hỗ trợ: CSS, `{ text }`, `{ role, name }` (nhận cả regex), `{ placeholder }`,
`{ label }`, `{ testid }`, `{ title }`, `{ alt }`, `{ xpath }`, và `{ index: n }` để chọn phần tử thứ n.

Các bước được hỗ trợ: `goto`, `click`, `fill`, `type`, `insertText`, `press`, `upload`, `waitFor`,
`waitForAny`, `waitForGone`, `waitForUrl`, `wait`, `eval`, `when`, `ifFound`, `retry`, `assert`, `log`.

Xem [docs/PLATFORM-SPEC.md](docs/PLATFORM-SPEC.md) để biết đặc tả đầy đủ.

---

## API

Tất cả endpoint nằm dưới `/api`. Server lắng nghe `127.0.0.1` — **không có xác thực**, nên
**không** đổi `HOST` thành `0.0.0.0` trừ khi bạn tự thêm lớp xác thực.

<details>
<summary>Danh sách endpoint</summary>

```
GET    /api/health                      Tình trạng server, browser, worker
GET    /api/platforms                   Danh sách nền tảng + flow hỗ trợ
POST   /api/platforms/resolve           Nhận diện loại/ID từ danh sách URL
GET    /api/platforms/:id/flow          Các bước của flow (để gỡ lỗi selector)
GET    /api/stats                       Số liệu cho dashboard
GET    /api/logs · DELETE /api/logs     Nhật ký
GET    /api/settings · PUT              Cấu hình mặc định
GET    /api/browsers · /api/worker      Trình duyệt đã cài, tình trạng worker

GET    /api/accounts · POST             Danh sách / tạo tài khoản
PATCH  /api/accounts/:id · DELETE
POST   /api/accounts/:id/login          Mở cửa sổ đăng nhập thủ công (202)
POST   /api/accounts/:id/check          Kiểm tra phiên còn hiệu lực
POST   /api/accounts/:id/close          Đóng trình duyệt của tài khoản

GET    /api/targets · POST              Nhóm / trang
POST   /api/targets/import              Import hàng loạt từ text
PATCH  /api/targets/:id · DELETE
POST   /api/targets/delete-bulk

GET    /api/posts · POST                Bài viết
GET    /api/posts/:id · PATCH · DELETE
POST   /api/posts/import                Import nhiều bài
POST   /api/posts/delete-bulk

POST   /api/media?name=file.jpg         Upload nhị phân (body = bytes)
GET    /api/media · DELETE /api/media/:name

GET    /api/jobs · POST                 Chiến dịch
GET    /api/jobs/:id · DELETE
GET    /api/jobs/:id/items              Các lượt đăng (lọc ?status=)
POST   /api/jobs/preview                Dự đoán số lượt đăng
POST   /api/jobs/:id/pause | resume | cancel | run-now | retry-failed

GET    /api/reports/summary?days=30     Báo cáo tổng hợp
GET    /api/projects · POST · DELETE    Dự án
```

</details>

---

## Kiểm thử

```bash
npm test              # smoke test API (18 kiểm tra) — cần server đang chạy
npm run test:browser  # Playwright + Edge: mở browser, locator, chụp ảnh, selector Facebook thật
npm run test:flow     # E2E engine đăng bài trên trang "nhóm" giả lập cục bộ
npm run test:ui       # Render dashboard trong trình duyệt, bắt lỗi console
npm run doctor        # kiểm tra môi trường
```

`test:flow` dựng một HTTP server cục bộ giả lập trang nhóm, rồi kiểm chứng:
dry-run điền nội dung + đính ảnh nhưng **không gửi bài nào**; chế độ thật gửi đúng nội dung;
phát hiện thông báo bị chặn; rẽ nhánh `when`; và template giữ nguyên kiểu mảng.

`test:browser` và `test:flow` cần khởi động được trình duyệt — trong môi trường sandbox chặn
named pipe, cần chạy ngoài sandbox.

---

## Sử dụng có trách nhiệm

> **Chỉ đăng vào nơi bạn được phép.**
>
> - Dùng cho nhóm/trang mà **bạn là quản trị viên** hoặc nơi việc đăng bài quảng bá **được cho phép**.
> - Đăng cùng một nội dung vào nhiều nhóm không liên quan là **spam** — vi phạm điều khoản của mọi
>   nền tảng và có thể khiến tài khoản bị khoá vĩnh viễn.
> - **Mỗi nhóm có quy định riêng** — đọc trước khi đăng. Nên viết biến thể nội dung cho từng nhóm;
>   nội dung trùng lặp hoàn toàn là dấu hiệu spam rõ ràng nhất.
> - Tool dùng giao diện web như một người dùng bình thường, **không can thiệp vào hệ thống nền tảng**
>   và không có tính năng lách kiểm soát (captcha, proxy, fingerprint).
> - Bạn tự chịu trách nhiệm tuân thủ điều khoản sử dụng của từng nền tảng.

---

## Giấy phép

Dùng nội bộ. Không kèm bảo hành.
