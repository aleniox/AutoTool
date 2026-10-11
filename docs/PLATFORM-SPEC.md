# Đặc tả Platform Adapter

Một nền tảng = **một file khai báo** trong `src/platforms/`. Không có logic riêng:
tất cả đều chạy qua bộ máy ở `src/core/flow.js`. Nhờ vậy, thêm nền tảng mới = thêm dữ liệu,
không sửa engine.

```js
import { definePlatform, RATE_LIMIT_BLOCKERS } from './_shared.js';
import { composeText } from '../core/flow.js';

export default definePlatform({
  id: 'vidu',
  name: 'Ví dụ',
  color: '#123456',
  loginUrl: 'https://vidu.com/login',
  homeUrl: 'https://vidu.com/',
  verified: false,
  experimental: false,
  notes: 'Mô tả ngắn hiển thị trong dashboard.',
  caps: { text: true, image: true, video: false, link: true, kinds: ['group', 'profile'] },
  limits: { maxChars: 2000, maxImages: 10, maxVideos: 0 },
  targetKinds: [...],
  session: {...},
  blockers: RATE_LIMIT_BLOCKERS,
  prepare(ctx) { return { text: composeText(ctx.post) }; },
  flows: {...},
});
```

---

## Các trường

| Trường | Bắt buộc | Mô tả |
|---|---|---|
| `id` | ✅ | Định danh duy nhất, chữ thường |
| `name` | | Tên hiển thị |
| `color` | | Màu nhãn trên dashboard |
| `loginUrl` | | Trang mở ra khi bấm "Đăng nhập" |
| `homeUrl` | | Trang chủ, dùng làm URL dự phòng |
| `verified` | | `true` = flow đã chạy thật thành công |
| `experimental` | | `true` = selector có thể lệch nhiều |
| `notes` | | Ghi chú hiển thị cho người dùng |
| `caps.kinds` | | Các loại mục tiêu hỗ trợ: `group`, `page`, `profile`, `channel`, `subreddit` |
| `limits` | | Giới hạn ký tự / số ảnh / số video |
| `targetKinds` | | Cách nhận diện mục tiêu từ URL |
| `session` | | Cách kiểm tra phiên đăng nhập |
| `blockers` | | Dấu hiệu bị chặn để dừng sớm |
| `prepare(ctx)` | | Chuẩn hoá nội dung (cắt bớt, đổi định dạng) |
| `flows` | ✅ | Các luồng đăng bài, key = loại mục tiêu |

---

## `targetKinds` — nhận diện mục tiêu từ URL

```js
targetKinds: [
  {
    kind: 'group',
    label: 'Nhóm',
    match: [/facebook\.com\/groups\/([^/?#]+)/i],
    buildUrl: (t) => `https://www.facebook.com/groups/${t.external_id}`,
  },
]
```

- `match`: mảng regex. **Nhóm bắt đầu tiên** là `externalId`.
- `buildUrl(t)`: URL đích khi đăng (nhận row `targets`, dùng `t.external_id`).

Nếu nền tảng chỉ có trang cá nhân (X, Instagram, Threads, TikTok), để `targetKinds: []` —
khi tạo tài khoản, tool sẽ **tự tạo sẵn một mục tiêu `profile`**.

---

## `session` — kiểm tra phiên đăng nhập

```js
session: {
  probeUrl: 'https://www.facebook.com/me',
  loggedIn:  ['div[aria-label="Your profile"]', 'a[href*="/friends"]'],
  loggedOut: ['input[name="email"]', '#login_form'],
}
```

`loggedOut` được kiểm tra **trước**; nếu thấy thì kết luận "hết phiên" ngay.
Sau đó `loggedIn` phải khớp trong 8 giây; nếu không → "hết phiên".

---

## `blockers` — phát hiện bị chặn

```js
blockers: [
  {
    when: [{ text: /temporarily blocked/i }],
    message: 'Nền tảng báo bị chặn tạm thời.',
    kind: 'rate_limit',   // rate_limit | blocked | auth | error
  },
]
```

`kind` quyết định cách worker phản ứng:

| `kind` | Phản ứng của worker |
|---|---|
| `rate_limit` | Hoãn lượt đăng 15–45 phút rồi thử lại |
| `auth` | Đánh dấu tài khoản hết phiên + **tạm dừng mọi chiến dịch** liên quan |
| `blocked` | Thất bại ngay, không thử lại |
| `error` | Thử lại theo backoff (1, 2, 4… phút) |

`RATE_LIMIT_BLOCKERS` trong `_shared.js` chứa bộ dấu hiệu chung (Anh + Việt).

---

## `flows` — luồng đăng bài

```js
flows: {
  group: {
    startUrl: (t) => `https://vidu.com/groups/${t.external_id}`,   // hoặc chuỗi
    steps: [ /* ... */ ],
  },
}
```

- Key của `flows` phải khớp với `kind` của mục tiêu. Nếu không khớp, runner dùng flow đầu tiên.
- Runner tự gán `ctx.startUrl` rồi chạy `steps`. Bước đầu thường là `{ goto: '{{startUrl}}' }`.

### Đối tượng `ctx`

| Biến | Nội dung |
|---|---|
| `{{text}}` | Nội dung đã ghép (tiêu đề + caption + hashtag + link), hoặc do `prepare()` trả về |
| `{{title}}` | Tiêu đề (Reddit dùng) |
| `{{startUrl}}` | URL xuất phát của flow |
| `{{post.caption}}`, `{{post.link}}`, `{{post.hashtags}}` | Trường của bài viết |
| `{{target.name}}`, `{{target.externalId}}`, `{{target.kind}}` | Mục tiêu |
| `{{account.label}}`, `{{account.platform}}` | Tài khoản |
| `{{mediaPaths}}` | **Mảng** đường dẫn tuyệt đối của mọi media |
| `{{imagePaths}}` / `{{videoPaths}}` | Mảng đường dẫn ảnh / video |
| `{{media[0].name}}` | Truy cập theo chỉ số |

> **Quan trọng:** placeholder đứng **một mình** giữ nguyên kiểu dữ liệu gốc.
> `'{{imagePaths}}'` → `string[]`. Còn `'Ảnh: {{imagePaths}}'` → chuỗi nối bằng dấu phẩy.
> Luôn dùng dạng đứng một mình cho `files` của bước `upload`.

`ctx` cũng có thể chứa giá trị do bước `eval` lưu lại (`saveAs`).

---

## Các bước (`steps`)

Mỗi bước là một object có **đúng một** khoá hành động, cộng các thuộc tính chung:

| Thuộc tính chung | Mặc định | Ý nghĩa |
|---|---|---|
| `optional: true` | `false` | Không tìm thấy phần tử thì bỏ qua thay vì báo lỗi |
| `timeout: <ms>` | `BROWSER_STEP_TIMEOUT_MS` | Thời gian chờ riêng cho bước này |
| `submit: true` | `false` | **Đánh dấu bước bấm nút Đăng** → tự động bỏ qua ở chế độ thử |
| `after: <ms>` | `0` | Nghỉ thêm sau khi bước hoàn tất |

### Danh sách hành động

| Bước | Ví dụ | Ghi chú |
|---|---|---|
| `goto` | `{ goto: '{{startUrl}}' }` | Báo lỗi rõ nếu URL rỗng/không hợp lệ |
| `click` | `{ click: ['#a', { role: 'button', name: /Đăng/ }] }` | Thử lần lượt; nếu bị overlay che sẽ fallback sang `el.click()` |
| `fill` | `{ fill: 'div[contenteditable]', value: '{{text}}' }` | Tự nhận biết `contenteditable` → dùng `insertText` + kiểm tra lại + fallback gõ từng ký tự |
| `type` | `{ type: '#search', value: '{{target.name}}', delay: 40 }` | Gõ như người thật |
| `insertText` | `{ insertText: '#editor', value: '{{text}}' }` | Chèn text một lần, an toàn với React/Draft.js |
| `press` | `{ press: 'Enter' }` hoặc `{ press: 'Escape', on: '#x' }` | |
| `upload` | `{ upload: 'input[type=file]', files: '{{imagePaths}}' }` | `files` là **mảng** đường dẫn tuyệt đối |
| `waitFor` | `{ waitFor: 'div[role=dialog]' }` | |
| `waitForAny` | `{ waitForAny: [selA, selB] }` | Chờ **một trong** các selector |
| `waitForGone` | `{ waitForGone: 'div[role=dialog]' }` | Chờ phần tử biến mất |
| `waitForUrl` | `{ waitForUrl: /reddit\.com\/r\// }` | |
| `wait` | `{ wait: 2000 }` | Nghỉ cố định |
| `eval` | `{ eval: (ctx) => ctx.imagePaths.length, saveAs: 'n' }` | Hàm hoặc chuỗi biểu thức, lưu vào `ctx` |
| `when` | `{ when: (ctx) => ctx.mediaPaths.length, then: [...], else: [...] }` | Rẽ nhánh theo điều kiện |
| `ifFound` | `{ ifFound: '#x', timeout: 3000, then: [...], else: [...] }` | Rẽ nhánh theo sự hiện diện của phần tử |
| `retry` | `{ retry: 3, backoff: 1500, steps: [...] }` | Thử lại một nhóm bước |
| `assert` | `{ assert: (ctx, page) => ..., message: '...' }` | Ném lỗi nếu trả về falsy |
| `log` | `{ log: 'Đã mở composer' }` | Ghi vào trace |

### Locator descriptor

```js
'div.foo'                          // CSS
{ css: 'div.foo' }
{ xpath: '//button' }
{ text: 'Đăng', exact: false }     // getByText
{ role: 'button', name: /Đăng/ }   // getByRole — name nhận cả chuỗi và regex
{ placeholder: 'Tìm kiếm' }
{ label: 'Nội dung' }
{ testid: 'tweetButton' }
{ title: '...' } / { alt: '...' }
{ index: 2, css: 'li.item' }       // phần tử thứ 3
[ d1, d2, d3 ]                     // thử lần lượt, cái nào hiện trước thì dùng
```

**Luôn đưa nhiều phương án.** Giao diện nền tảng đổi thường xuyên; mảng dự phòng là cách
duy nhất để flow sống sót qua các đợt đổi giao diện.

---

## `prepare(ctx)` — chuẩn hoá nội dung

```js
prepare({ post }) {
  const full = composeText(post);
  return { text: truncate(full, 280), truncated: full.length > 280 };
}
```

Trả về object được `Object.assign` vào `ctx`, nên có thể ghi đè `text` hoặc thêm biến mới
dùng được trong template. Ví dụ Reddit trả về cả `title` và `text` riêng.

---

## Ví dụ đầy đủ tối giản

```js
import { definePlatform, RATE_LIMIT_BLOCKERS, truncate } from './_shared.js';
import { composeText } from '../core/flow.js';

export default definePlatform({
  id: 'vidu',
  name: 'Ví dụ',
  color: '#0af',
  loginUrl: 'https://vidu.com/login',
  homeUrl: 'https://vidu.com/',
  caps: { text: true, image: true, link: true, kinds: ['group'] },
  limits: { maxChars: 500, maxImages: 4 },

  targetKinds: [
    { kind: 'group', label: 'Nhóm', match: [/vidu\.com\/g\/([^/?#]+)/i],
      buildUrl: (t) => `https://vidu.com/g/${t.external_id}` },
  ],

  session: {
    probeUrl: 'https://vidu.com/',
    loggedIn: ['[data-testid="avatar"]'],
    loggedOut: ['form[action="/login"]'],
  },

  blockers: RATE_LIMIT_BLOCKERS,

  prepare: ({ post }) => ({ text: truncate(composeText(post), 500) }),

  flows: {
    group: {
      startUrl: (t) => `https://vidu.com/g/${t.external_id}`,
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 2500 },
        { click: [{ role: 'button', name: /viết bài|write post/i }] },
        { waitFor: 'div[role="dialog"]' },
        { fill: 'div[role="dialog"] div[contenteditable="true"]', value: '{{text}}' },
        { upload: 'div[role="dialog"] input[type="file"]', files: '{{imagePaths}}', optional: true },
        { wait: 3000 },
        {
          click: [
            'div[role="dialog"] button[aria-label="Đăng"]',
            { role: 'button', name: /^(Đăng|Post)$/ },
          ],
          submit: true,   // ← chế độ thử sẽ dừng ở đây
        },
        { waitForGone: 'div[role="dialog"]', timeout: 60000, optional: true },
      ],
    },
  },
});
```

---

## Quy trình thêm nền tảng mới

1. Tạo `src/platforms/<id>.js` theo mẫu trên.
2. Thêm vào mảng `list` trong `src/platforms/index.js`.
3. `npm start`, tạo tài khoản cho nền tảng đó, đăng nhập, thêm **một** nhóm.
4. Tạo chiến dịch **chế độ thử**, đặt `HEADLESS=false`, chạy.
5. Xem trình duyệt thao tác + **Nhật ký** (mức `debug`). Chỉnh selector cho tới khi hết lỗi.
6. Chạy thật với một nhóm. Thành công → đổi `verified: true`.

`GET /api/platforms/<id>/flow` trả về danh sách bước đã đánh số, rất tiện để đối chiếu
với nhật ký khi gỡ lỗi.
