// Redraw from the current plot data when the viewport changes. Both inspectors
// share a single canvas slot, so switching blocks releases the old observer.
let observer;
export function fitChart(canvas, paint) {
  observer?.disconnect();
  let width = canvas.clientWidth;
  paint();
  observer = new ResizeObserver(() => {
    if (!canvas.isConnected) {
      observer.disconnect();
      return;
    }
    if (width !== canvas.clientWidth) {
      width = canvas.clientWidth;
      paint();
    }
  });
  observer.observe(canvas);
}
