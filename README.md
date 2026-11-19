# sFrED ML Lab

Build a classification or regression pipeline from multisensor recordings collected with a PAL V2 kit. The lab runs in the browser and reads PAL schema-v2 HDF5 files containing motion, audio, and environmental measurements. Six built-in example trials let students try the workflow without recordings or hardware.

## Run the lab

Install Node.js 22 or newer. Then run these commands in a terminal.

```sh
git clone https://github.com/Ibrahimhk98/2.sFrED_ML_Lab.git
cd 2.sFrED_ML_Lab
npm ci
npm run serve
```

Open [the behavior lab](http://localhost:8001). Choose **Import recordings** on the canvas, then open your files or select **Try six example recordings**. Keep the terminal running while using the lab. Recordings and model fitting stay in the browser. Save a trained model before closing or refreshing the tab.

Firmware, kit setup, recording, and the original recording explorer are in the [PAL V2 acquisition repository](https://github.com/Ibrahimhk98/PAL-V2-Bluetooth).

## Build a pipeline

The canvas opens with a connected starter pipeline. Choose **Blank canvas** to build one from scratch. Drag blocks from the library onto the grid. Connect an output on the right of one block to a compatible input on the left of another. You can also click a library entry to place a block and click two ports to connect them. Double-click a block for its settings. Pan by dragging the grid or choose **Fit** to see the whole pipeline.

1. **Import and label recordings.** Give repeated trials of the same behavior the same label. Classification accepts names or numeric class codes. Choose regression for a continuous numeric target.
2. **Inspect signals.** In **Signal scope**, overlay the same channel from two recordings. Adjust the start time and window length, then switch to FFT to compare frequency content in that interval.
3. **Split and window.** Set window length and overlap. With six recordings of two behaviors, you can reserve one complete recording per behavior for each of training, validation, and test. If you have one recording per behavior, choose **Time blocks**. Its scores describe later periods of those same recordings. Windows stay inside their assigned partition.
4. **Filter and extract features.** Choose channels, set low-pass, high-pass, or band-pass filters for each input, and select time-domain, frequency-domain, or raw features. Each feature row covers one time window across the selected sensors. Connect a normalization block to scale features using training data.
5. **Explore features.** Connect **Feature plots** to the extracted or normalized feature table. Choose **Extract & plot features** to view distributions by label, plot two features against each other, or trace a feature through a recording. For regression, you can plot a feature against its target. Plots use training windows.
6. **Train and compare.** Connect model blocks to the feature table or normalization output, then wire their outputs to **Compare models**. Choose from nearest neighbors, ridge, decision tree, random forest, and Gaussian kernel. Tune each block, then choose **Train pipeline**. Compare on the same validation windows using macro F1 for classification or RMSE for regression. Use **Reveal test scores** for the held-out evaluation. Classification includes a confusion matrix, precision, recall, F1, and ROC AUC. Regression includes MAE, RMSE, and R².
7. **Save and predict.** In **Save & run live**, export a model as JSON. It includes the learned parameters, labels, channel order, features, and preprocessing needed for prediction. Open a saved model in a fresh lab session to use it again.

## Predict with a connected kit

Open **Live kit** from the lab header and leave both tabs open. Choose USB serial, Bluetooth LE, or Wi-Fi. For Wi-Fi, use the IP address or local hostname of a kit already on your network. Chrome or Edge on localhost supports the direct USB connection. Bluetooth availability depends on the browser and operating system. Release the kit from any other application using the same serial or Bluetooth connection.

Back in **Save & run live**, select the model and connected kit, then choose **Start prediction**. The first result appears after every sensor required by the model has supplied a full window. A hardware or transport change starts a fresh window.

### Optional USB bridge

If the browser cannot list the serial adapter, start the lab’s bridge in a second terminal from this checkout. On macOS or Linux with Python 3.10 or newer, run the following commands.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r scripts/requirements-usb.txt
.venv/bin/python scripts/usb_bridge.py
```

On Windows, use `.venv\Scripts\python.exe` for the last two commands. If multiple serial adapters are attached, add `--port DEVICE`, substituting the serial path or COM port. Choose **Connect USB bridge** in the Live kit tab. The bridge uses loopback port 8767 and accepts the lab served on port 8001.

## Development

Run `npm test` after `npm ci`. The install builds the browser’s HDF5 and numerical dependencies from the lockfile. The graph editor, feature extraction, models, worker, and plots live in `dashboard/lab/`. The standalone kit connection and PAL protocol decoders live in `dashboard/`.
