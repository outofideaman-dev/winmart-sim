# WinMart V6.1 — Gói Web Tĩnh Chuẩn Hóa Cho GitHub Pages (`Web_GitHub_Pages`)

Thư mục này đã được chuẩn hóa gọn nhẹ (`~170 KB`, đuôi `.js` chuẩn ES Module kèm `.nojekyll`) để có thể đẩy trực tiếp lên **GitHub Pages** (hoặc Vercel, Netlify, Cloudflare Pages) mà không cần máy chủ Python hay Node.js.

## Danh sách tệp trong gói Web tĩnh

- `index.html`: Giao diện điều phối kho `5.000 m²` (10 thiết bị: `XN1–XN6` + `CP1–CP4`, kệ 3 tầng `1.764` vị trí, `12` dock xuất `DX1–DX12`, `6` bến nhập `DIN1–DIN6`).
- `styles.css`: Định dạng giao diện responsive.
- `app.js` & `core.js`: Bộ máy mô phỏng tất định bước 1 giây và trình kết xuất Canvas 2D chuẩn ES Module (`.js`).
- `map.svg`, `Khu_nguon_ghep.svg`, `Khu_nhap.svg`, `Chat_xe.svg`: Các bản vẽ kỹ thuật vector hiển thị trên giao diện.
- `data/summary.json` & `data/verification.json`: Dữ liệu tổng hợp kết quả 10 kịch bản và 17 phép kiểm thử bất biến (đã loại bỏ tệp log CLI 10,4 MB để đẩy lên GitHub nhanh tức thì).
- `.nojekyll`: Tệp cấu hình báo cho GitHub Pages bỏ qua bộ biên dịch Jekyll, phục vụ trực tiếp toàn bộ tài nguyên tĩnh.

## Hướng dẫn đẩy lên GitHub và bật GitHub Pages

### Bước 1: Đẩy thư mục này lên một Repository GitHub mới
Mở Terminal / PowerShell ngay trong thư mục `Web_GitHub_Pages` và chạy:

```powershell
git init
git add .
git commit -m "Deploy WinMart V6.1 Warehouse Simulation Web"
git branch -M main
git remote add origin https://github.com/<ten-tai-khoan>/<ten-repo>.git
git push -u origin main
```

### Bước 2: Bật GitHub Pages
1. Truy cập Repository trên GitHub → chọn tab **Settings** → mục **Pages** (thanh bên trái).
2. Trong phần **Build and deployment**:
   - **Source:** chọn `Deploy from a branch`
   - **Branch:** chọn `main` và thư mục `/ (root)` → nhấn **Save**.
3. Đợi khoảng 30–60 giây, trang web sẽ được xuất bản tại địa chỉ:
   `https://<ten-tai-khoan>.github.io/<ten-repo>/`
