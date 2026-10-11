import { api } from '../api.js';
import { esc, platformTag } from '../ui.js';

export const title = 'Hướng dẫn';

export async function render(root) {
  const { platforms } = await api.platforms();

  root.innerHTML = `
  <div class="card help">
    <h2>Bắt đầu trong 4 bước</h2>
    <ol>
      <li><strong>Thêm tài khoản</strong> ở mục <a href="#/accounts">Tài khoản</a> — chọn nền tảng, đặt tên gợi nhớ.</li>
      <li>Bấm <strong>Đăng nhập</strong> — một cửa sổ trình duyệt mở ra, bạn đăng nhập thủ công (kể cả 2FA).
          Sau đó bấm <strong>Kiểm tra</strong> để xác nhận phiên còn hiệu lực.</li>
      <li><strong>Thêm nhóm / trang</strong> ở mục <a href="#/targets">Nhóm &amp; Trang</a> —
          dán danh sách URL, mỗi dòng một nhóm.</li>
      <li><strong>Tạo bài viết</strong> ở mục <a href="#/posts">Bài viết</a>, rồi vào
          <a href="#/jobs">Chiến dịch</a> để chọn bài × nhóm và đặt lịch.</li>
    </ol>

    <div class="note info">
      <strong>Nên chạy "Chế độ thử" (dry-run) trước.</strong> Tool sẽ mở trình duyệt, điền nội dung và đính ảnh
      y như thật nhưng dừng lại trước khi bấm nút Đăng. Xem <a href="#/logs">Nhật ký</a> và ảnh chụp lúc lỗi
      để biết cần chỉnh gì.
    </div>

    <h3>Bảo mật</h3>
    <p>Tool <strong>không lưu mật khẩu</strong> ở bất kỳ đâu. Nó chỉ giữ profile trình duyệt đã đăng nhập
    trong <code>data/profiles/&lt;id&gt;-&lt;nền tảng&gt;/</code>. Ai có quyền truy cập thư mục này thì có thể dùng
    phiên đăng nhập của bạn — hãy bảo vệ thư mục <code>data/</code> như bảo vệ mật khẩu.</p>

    <h3>Nhịp đăng an toàn</h3>
    <p>Các nền tảng đều có hệ thống chống spam. Mặc định tool nghỉ ngẫu nhiên
    <strong>120–360 giây</strong> giữa hai bài của cùng một tài khoản và giới hạn
    <strong>15 bài/ngày/tài khoản</strong>. Đừng tắt những giới hạn này — chúng bảo vệ tài khoản của bạn.</p>

    <h3>Định dạng import nhóm</h3>
    <pre>https://www.facebook.com/groups/123456789
https://www.facebook.com/groups/123456789 | Nhóm Mua Bán Đồ Cũ
Nhóm Mua Bán Đồ Cũ | https://www.facebook.com/groups/123456789
# dòng bắt đầu bằng dấu thăng sẽ bị bỏ qua</pre>
    <p>Với Telegram, có thể dùng <code>@tenkenh</code> hoặc <code>https://t.me/tenkenh</code>.<br>
    Với nhóm riêng tư không có URL, nhập tên nhóm — tool sẽ tìm trong danh sách hội thoại.</p>

    <h3>Định dạng import bài viết</h3>
    <pre>Tiêu đề: Khuyến mãi tháng 12
Link: https://example.com/sale
Ảnh: ten-file-1.jpg, ten-file-2.jpg
#khuyenmai #sale

Nội dung chi tiết của bài viết…
---
Tiêu đề: Bài thứ hai
Nội dung bài thứ hai…</pre>
    <p>Các bài cách nhau bằng dòng <code>---</code>. Dòng <code>Ảnh:</code> dùng tên file đã upload
    trong thư viện media.</p>

    <h3>Chiến lược ghép bài × nhóm</h3>
    <ul>
      <li><strong>Mỗi bài → mọi nhóm</strong>: 3 bài × 10 nhóm = 30 lượt đăng.</li>
      <li><strong>Chia đều, xoay vòng</strong>: mỗi nhóm nhận số bài bằng nhau, không trùng bài trong cùng nhóm.</li>
      <li><strong>Ghép 1-1 theo thứ tự</strong>: bài 1 → nhóm 1, bài 2 → nhóm 2…</li>
    </ul>
  </div>

  <div class="card">
    <h2>Tình trạng hỗ trợ từng nền tảng</h2>
    <div class="sub mb">Selector của các nền tảng thay đổi thường xuyên. Cột "đã kiểm chứng" cho biết
      flow đã được chạy thật thành công hay chưa.</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Nền tảng</th><th>Trạng thái</th><th>Hỗ trợ</th><th>Giới hạn</th><th>Ghi chú</th></tr></thead>
      <tbody>
        ${platforms
          .map(
            (p) => `<tr>
          <td>${platformTag(p.name, p.color)}</td>
          <td>${
            p.verified
              ? '<span class="badge ok">Đã kiểm chứng</span>'
              : p.experimental
                ? '<span class="badge err">Thử nghiệm</span>'
                : '<span class="badge warn">Chưa kiểm chứng</span>'
          }</td>
          <td class="tiny">${esc((p.kinds ?? []).map((k) => k.label).join(', ') || 'Trang cá nhân')}</td>
          <td class="tiny muted">${p.limits?.maxChars || '∞'} ký tự<br>${p.limits?.maxImages ?? 0} ảnh</td>
          <td class="tiny muted" style="max-width:340px">${esc(p.notes)}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table></div>
  </div>

  <div class="card help">
    <h2>Khi selector bị lệch</h2>
    <p>Nếu tool báo "Không tìm thấy phần tử", nền tảng đó vừa đổi giao diện. Cách xử lý:</p>
    <ol>
      <li>Chạy chiến dịch ở <strong>chế độ thử</strong> với <code>HEADLESS=false</code> để xem trình duyệt thao tác.</li>
      <li>Mở <a href="#/logs">Nhật ký</a>, lọc mức <code>debug</code> để xem bước nào thất bại.</li>
      <li>Sửa selector trong <code>src/platforms/&lt;nền tảng&gt;.js</code>. Mỗi selector là một
          <strong>mảng nhiều phương án</strong> — chỉ cần thêm phương án mới vào đầu mảng.</li>
    </ol>
    <pre>// Vi du: them phuong an moi cho nut Dang cua Facebook
{
  click: [
    'div[role="dialog"] div[aria-label="Đăng"][role="button"]',  // &lt;-- them dong nay
    { role: 'button', name: /^(Post|Đăng)$/ },
  ],
  submit: true,   // danh dau day la buoc bam Dang -> bi bo qua o che do thu
}</pre>

    <h3>Lệnh CLI hữu ích</h3>
    <pre>npm run cli -- doctor      # kiểm tra môi trường
npm run cli -- platforms   # liệt kê nền tảng &amp; flow
npm run cli -- stats       # thống kê nhanh
npm start                  # chạy server + worker</pre>
  </div>

  <div class="card help">
    <h2>Lưu ý sử dụng có trách nhiệm</h2>
    <div class="note danger">
      <p><strong>Chỉ đăng vào nơi bạn được phép.</strong> Hãy dùng tool cho nhóm/trang mà bạn là quản trị viên
      hoặc thành viên và nơi việc đăng bài quảng bá được cho phép. Đăng nội dung giống nhau vào nhiều nhóm
      không liên quan là spam — vi phạm điều khoản của mọi nền tảng và có thể khiến tài khoản bị khoá vĩnh viễn.</p>
      <p>Mỗi nhóm đều có quy định riêng. Hãy đọc trước khi đăng. Nội dung trùng lặp hoàn toàn trên nhiều nhóm
      cũng là dấu hiệu spam — nên viết biến thể cho từng nhóm.</p>
      <p>Tool này dùng giao diện web như một người dùng bình thường, không can thiệp vào hệ thống của nền tảng.
      Bạn tự chịu trách nhiệm về việc tuân thủ điều khoản sử dụng của từng nền tảng.</p>
    </div>
  </div>
  `;
}
