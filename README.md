# Redis stream listener (debug UI)

App Node.js nghe Redis Stream (`XREAD`), log terminal + UI web (SSE).

## Chạy local

```bash
cp .env.example .env
# Sửa REDIS_URL, STREAM_KEYS cho đúng engine của bạn

npm install
npm run dev
```

Mở trình duyệt: `http://127.0.0.1:3847` (hoặc đúng `PORT` trong `.env`).

### Gửi 1 event test (optional)

```bash
npm run publish-test
```

---

## Deploy (production)

Trên server / nền tảng deploy (Render, Fly.io, Railway, …) cần **cùng Redis** mà trading engine dùng (URL phải truy cập được từ mạng đó, không chỉ `localhost` máy bạn).

**Lệnh chuẩn:**

```bash
npm install
npm run build
npm start
```

- **Build:** tạo thư mục `dist/`.
- **Start:** chạy `node dist/server.js` (không dùng `npm run dev` trên production).

**Biến môi trường** (cấu hình trên dashboard hoặc file env của host):

| Biến | Ý nghĩa |
|------|---------|
| `REDIS_URL` | URL Redis (bắt buộc) |
| `STREAM_KEYS` | Tên stream, cách nhau bởi dấu phẩy (mặc định `fill:price`) |
| `PORT` | Cổng HTTP; nhiều host tự set `PORT`, không cần sửa |
| `FROM_START` | `1` hoặc `true` nếu muốn đọc từ đầu stream (mặc định chỉ message mới) |
| `HISTORY_COUNT` | Số bản ghi gần nhất load khi mở UI (`XREVRANGE`, mặc định `20`, tối đa `500`) |

---

## Ghi chú

- **`XREAD` / `XREVRANGE` không xóa** message trên Redis; dữ liệu chỉ mất khi engine trim (`MAXLEN` trên `XADD`) hoặc khi bạn `XDEL` / `XTRIM`.
- UI tĩnh nằm trong `public/`, được serve từ thư mục gốc project khi chạy (`process.cwd()`). Deploy cần có cả `public/` cùng bản build (clone đủ repo, không chỉ file trong `dist/`).
