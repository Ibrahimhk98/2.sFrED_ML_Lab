export function download(bytes, filename, type) {
  const url = URL.createObjectURL(new Blob([bytes], {type}));
  const link = Object.assign(document.createElement('a'), {href:url, download:filename});
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
