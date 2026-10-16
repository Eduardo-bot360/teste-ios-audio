#!/usr/bin/env python3
"""Servidor local do teste, com suporte a Range requests.

O http.server padrao do Python nao responde 206 Partial Content. O Safari no
iOS pede Range para midia — sem isso o audio de 27 min pode simplesmente nao
tocar, e o teste mediria o servidor em vez do iPhone.

Uso:  python3 servidor.py [porta]
"""
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

RAIZ = os.path.dirname(os.path.abspath(__file__))


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.mp3': 'audio/mpeg',
        '.js': 'text/javascript',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
    }

    def end_headers(self):
        # nada de cache: cada abertura do app pega a versao atual dos arquivos
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def send_head(self):
        faixa = self.headers.get('Range')
        if not faixa:
            return super().send_head()

        caminho = self.translate_path(self.path)
        if os.path.isdir(caminho):
            return super().send_head()
        try:
            f = open(caminho, 'rb')
        except OSError:
            self.send_error(404, 'File not found')
            return None

        tamanho = os.fstat(f.fileno()).st_size
        m = re.match(r'bytes=(\d*)-(\d*)$', faixa.strip())
        if not m:
            f.close()
            self.send_error(400, 'Range invalido')
            return None

        ini, fim = m.group(1), m.group(2)
        if ini == '':                              # bytes=-N  (ultimos N bytes)
            n = int(fim or 0)
            ini = max(0, tamanho - n)
            fim = tamanho - 1
        else:
            ini = int(ini)
            fim = int(fim) if fim else tamanho - 1
        fim = min(fim, tamanho - 1)
        if ini > fim or ini >= tamanho:
            f.close()
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{tamanho}')
            self.end_headers()
            return None

        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(caminho))
        self.send_header('Content-Range', f'bytes {ini}-{fim}/{tamanho}')
        self.send_header('Content-Length', str(fim - ini + 1))
        self.end_headers()
        f.seek(ini)
        return FatiaDeArquivo(f, fim - ini + 1)

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


class FatiaDeArquivo:
    """Arquivo que entrega no maximo N bytes — o copyfile do handler usa isso."""

    def __init__(self, f, restante):
        self.f = f
        self.restante = restante

    def read(self, n=-1):
        if self.restante <= 0:
            return b''
        if n < 0 or n > self.restante:
            n = self.restante
        dados = self.f.read(n)
        self.restante -= len(dados)
        return dados

    def close(self):
        self.f.close()


if __name__ == '__main__':
    porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    srv = ThreadingHTTPServer(('0.0.0.0', porta), partial(Handler, directory=RAIZ))
    print(f'Servindo {RAIZ} em http://localhost:{porta}  (Range habilitado)')
    srv.serve_forever()
