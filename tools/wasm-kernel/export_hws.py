"""export_hws.py -- write a toolkit state_dict as one self-describing browser weight file (".hws").

  python3 -I export_hws.py <model.pt> <meta.json> <out.hws> [--big i16|i8|f16|f32] [--small f32|f16]

File layout (little endian):
  0   4  magic  b"HWS1"
  4   4  uint32 header length N
  8   N  UTF-8 JSON header, then zero padding to a multiple of 8
  ...    payload; every tensor entry in the header has {name, shape, dtype, offset, length[, scale_offset]}
         offsets are relative to the start of the payload.
dtypes:  f32  float32
         f16  IEEE half floats
         i16r int16, one float32 scale per row:  W[j, :] = scale[j] * q[j, :]   (rows = first dimension)
         i8r  int8, same scheme
"big" tensors are the three LSTM matrices lstmN.W_xh (95.6 % of all parameters); everything else is "small".
"""
import sys, json, struct
import numpy as np, torch

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opt = lambda k, d: (sys.argv[sys.argv.index('--' + k) + 1] if '--' + k in sys.argv else d)
ckpt, meta_path, out_path = args[:3]
big_dt, small_dt = opt('big', 'i16'), opt('small', 'f32')
sd = torch.load(ckpt, map_location='cpu', weights_only=True)
meta = json.load(open(meta_path))

payload = bytearray()
def put(b):
    while len(payload) % 8: payload.append(0)
    off = len(payload); payload.extend(b); return off

tensors = []
for name, v in sd.items():
    a = v.detach().numpy().astype(np.float32)
    e = {'name': name, 'shape': list(a.shape), 'length': int(a.size)}
    dt = big_dt if name.endswith('.W_xh') else small_dt
    if dt in ('i16', 'i8'):
        qmax = 32767 if dt == 'i16' else 127
        mx = np.abs(a).max(axis=1); scale = np.where(mx > 0, mx / qmax, 1).astype(np.float32)
        q = np.clip(np.rint(a.astype(np.float64) / scale[:, None].astype(np.float64)), -qmax, qmax)
        e['dtype'] = dt + 'r'
        e['offset'] = put(q.astype('<i2' if dt == 'i16' else 'i1').tobytes())
        e['scale_offset'] = put(scale.astype('<f4').tobytes())
    else:
        e['dtype'] = dt
        e['offset'] = put(a.astype('<f2' if dt == 'f16' else '<f4').tobytes())
    tensors.append(e)

header = {'format': 'hwsyn-weights-v1', 'arch': 'graves-synthesis-3x400-k10-m20', 'V': len(meta['charset']) + 1,
          'charset': meta['charset'], 'mu': meta['mu'], 'std': meta['std'], 'tensors': tensors}
hj = json.dumps(header, ensure_ascii=False).encode('utf-8')
hj += b' ' * ((-(8 + len(hj))) % 8)
with open(out_path, 'wb') as f:
    f.write(b'HWS1'); f.write(struct.pack('<I', len(hj))); f.write(hj); f.write(payload)
print(out_path, 8 + len(hj) + len(payload), 'bytes  big=' + big_dt, 'small=' + small_dt)
