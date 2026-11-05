# Mô phỏng điều phối kho WinMart

Ứng dụng tĩnh phục vụ học phần Quản lý dự án CNTT. Kết quả dưới đây thuộc giả định mô hình, chưa xác minh tại kho thực tế.

## Sử dụng

Chạy máy chủ HTTP tĩnh tại thư mục này; máy chủ cần trả `.mjs` với MIME JavaScript. Có thể chọn 14 cấu hình giao diện, tiến từng 5 phút, chạy nhanh bằng Worker, so sánh hai chính sách hoặc nhập Excel đầu ca. Chỉ nạp kế hoạch ca xuất tại t = 0; chưa hỗ trợ nhập giữa ca, nhiều ca từ Excel hoặc WMS/PLC.

QC cơ sở: 60 giây/pallet ghép (giả định). Nhân công +25% tác động kiểm nhận, đi bộ, chuẩn bị/nhặt kiện, QC và thu gom pallet rỗng; không đổi định mức nâng hạ.

## Kết quả kiểm chứng

Ca đơn đo tại đúng 28.800 giây; kịch bản liên hoàn đo 144.000 giây. `results.json` tách `at8h`, `final`, `postShift`. Đơn đúng hạn xét lúc đủ pallet rời kho, không phải lúc đến cửa hàng. Mẫu số trong bảng gồm mọi đơn ở mốc đo, kể cả chưa hoàn tất.

| Kịch bản | Mốc (giờ) | Pallet rời | Đơn hoàn tất | Đúng hạn / Tổng |
|---|---:|---:|---:|---:|
| Ca xuất chuẩn · Phương án đề xuất | 8 | 195 | 180/180 | 167/180 |
| Ca xuất chuẩn · Phương án cơ sở | 8 | 183 | 169/180 | 88/180 |
| Kế hoạch Excel Chuẩn (66 đơn · Phương án đề xuất) | 8 | 81 | 66/66 | 66/66 |
| Kế hoạch Excel Chuẩn (66 đơn · Phương án cơ sở) | 8 | 81 | 66/66 | 66/66 |
| Kế hoạch Excel Tải cao 8 giờ (150 đơn · Phương án đề xuất) | 8 | 168 | 141/150 | 141/150 |
| Kế hoạch Excel Tải cao 8 giờ (150 đơn · Phương án cơ sở) | 8 | 139 | 115/150 | 110/150 |
| Khóa cứng vùng kệ (tắt hỗ trợ chéo A⇄B) | 8 | 194 | 179/180 | 173/180 |
| Lệch tải 80% SKU Vùng A (Bật hỗ trợ chéo A⇄B) | 8 | 194 | 179/180 | 169/180 |
| Lệch tải 80% SKU Vùng A (Tắt hỗ trợ chéo A⇄B) | 8 | 190 | 175/180 | 142/180 |
| Thời gian thao tác nhân công tăng 25% | 8 | 173 | 160/180 | 58/180 |
| Bắt buộc 100% qua ô chờ xuất ST0–ST11 | 8 | 187 | 173/180 | 136/180 |
| Khởi đầu ca pin thấp 15% (sạc cân bằng vùng/nhóm) | 8 | 149 | 138/180 | 15/180 |
| Sự cố nghẽn hành lang + Cứu hộ F3 bàn giao pallet | 8 | 192 | 178/180 | 114/180 |
| Sự cố robot trong thùng xe 1 giờ (khóa DOCK_HOLD_FAULT) | 8 | 195 | 180/180 | 162/180 |
| Ca nhập 8 giờ độc lập (128 pallet · dỡ tuần tự, 2 luồng kiểm nhận) | 8 | 0 | 0/0 | 0/0 |
| Liên hoàn đa ca 40 giờ (Nhập – Chuyển ca – Xuất tuần hoàn) | 40 | 434 | 402/474 | 206/474 |

Chuẩn đề xuất: 177 pallet ghép đã qua QC và 18 pallet xuất nguyên rời kho; 15 pallet ghép cần nhiều đợt nguồn. Không có kịch bản 100% pallet ghép.

Cơ sở và đề xuất thay đổi tổ hợp thứ tự đơn, nhiệm vụ, chọn nguồn, đường đi, dock và chuyến; không quy toàn bộ cải thiện cho riêng WINDOW_FEFO. Bộ đếm chỉ ghi lựa chọn lô khác trong cửa sổ khi nguồn sớm hơn còn khả dụng. Dùng hết lô sớm rồi chuyển lô không tính.

`data/deadline_rules.json` ghi quy tắc lập hạn Excel; lịch xe giữ nguyên. `data/before_deadline_summary.json` ghi kết quả trước hiệu chỉnh. Sửa lỗi tính lại cửa sổ FEFO sau khi hết lô có thể làm thay đổi sản lượng.

## Kiểm thử và tái lập

`node verify.mjs` chạy 8 nhóm tích hợp; `node verify_metrics.mjs` chạy 5 kiểm tra FEFO/QC; `node run_v6.mjs` tạo 16 kết quả và bảng tổng hợp. Các kiểm tra và mã băm chỉ hỗ trợ đối chiếu những trường hợp đã xét, không chứng minh đúng tuyệt đối hay hiệu quả thực địa. Mã/tệp V6.1 lịch sử giữ riêng, không dùng trong so sánh chính.

## GitHub Pages

Giao diện được phát hành từ nhánh `main`: [Mở demo WinMart](https://outofideaman-dev.github.io/winmart-sim/).

Kho mã chứa giao diện, các mô-đun mô phỏng, thư viện Excel, hai kế hoạch Excel mẫu và bảng kết quả tổng hợp. Dữ liệu trạng thái chi tiết `data/results.json` được tạo khi chạy `node run_v6.mjs`, không cần tải để sử dụng giao diện.
