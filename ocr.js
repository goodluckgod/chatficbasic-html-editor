const MIN_RECTANGLE_WIDTH = 50;
const MIN_RECTANGLE_HEIGHT = 10;
const X_THRESHOLD_FOR_GROUPING = 25;

const DEBUG_COLORS = {
  LEFT: "blue",
  RIGHT: "green",
  NONE: "red",
};

let worker;
let importScreenshots;
let debugMode = false;

const initWorker = async () => {
  worker = await Tesseract.createWorker();
  await worker.setParameters();
};

const showImportScreenshotsModal = async () => {
  importScreenshots.show();
  document.getElementById("screenshotStatus").innerText =
    "Files are not uploaded, just processed by your browser.";
};

document.addEventListener("DOMContentLoaded", async () => {
  await initWorker();

  importScreenshots = new bootstrap.Modal(
    document.getElementById("importScreenshotsModal")
  );
});

const onImageUploadOCR = async (files) => {
  const filteredFiles = Array.from(files)
    .filter((file) => file.type.startsWith("image"))
    .sort((a, b) => naturalCompare(a.name, b.name));

  for await (const file of filteredFiles) {
    const currentIndex = filteredFiles.indexOf(file) + 1;

    const canvas = document.getElementById("ocrCanvas");

    // write the image to the canvas
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.src = URL.createObjectURL(file);

    await new Promise((resolve) => {
      img.onload = async () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0, img.width, img.height);
        document.getElementById(
          "screenshotStatus"
        ).innerText = `Processing ${currentIndex}/${filteredFiles.length} files.`;
        console.log(
          `Processing ${currentIndex}/${filteredFiles.length} files.`,
          file.name
        );
        await processImage(img, canvas, ctx);
        resolve();
      };
    });
  }

  document.getElementById("screenshotStatus").innerText = "Files processed.";
};
function calculateMedian(image) {
  const values = [];
  const data = image.data;
  for (let i = 0; i < data.length; i++) {
    values.push(data[i]);
  }
  values.sort((a, b) => a - b);
  const half = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return (values[half - 1] + values[half]) / 2;
  } else {
    return values[half];
  }
}

const processImage = async (img, canvas, ctx) => {
  const mat = cv.imread(canvas);

  // Convert to grayscale (optional but recommended for edge detection)
  const grayscaleImage = new cv.Mat();
  cv.cvtColor(mat, grayscaleImage, cv.COLOR_RGB2GRAY, 0);

  // Calculate median value
  const median = calculateMedian(grayscaleImage);

  // Define Canny's parameters based on the median value
  let cannyTh1, cannyTh2;
  const s = 0.33;
  if (median > 191) {
    // light images
    cannyTh1 = Math.max(0, (1 - 2 * s) * (255 - median));
    cannyTh2 = Math.max(85, (1 + 2 * s) * (255 - median));
  } else if (median > 127) {
    cannyTh1 = Math.max(0, (1 - s) * (255 - median));
    cannyTh2 = Math.min(255, (1 + s) * (255 - median));
  } else if (median < 63) {
    // dark images
    cannyTh1 = Math.max(0, (1 - 2 * s) * median);
    cannyTh2 = Math.max(85, (1 + 2 * s) * median);
  } else {
    cannyTh1 = Math.max(0, (1 - s) * median);
    cannyTh2 = Math.min(255, (1 + s) * median);
  }
  // Apply Gaussian blur (optional for noise reduction)
  const blurredImage = new cv.Mat();
  const ksize = new cv.Size(5, 5); // Adjust kernel size as needed
  cv.GaussianBlur(
    grayscaleImage,
    blurredImage,
    ksize,
    0,
    0,
    cv.BORDER_REPLICATE
  );

  // Perform Canny edge detection with parameter tuning
  const edges = new cv.Mat();
  const apertureSize = 3; // Sobel kernel size (common value)
  cv.Canny(blurredImage, edges, cannyTh1, cannyTh2, apertureSize, false); // Use gradient magnitude

  // Find contours (using the Canny edge image)
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(
    edges,
    contours,
    hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE
  );
  const rectengles = groupRectangles(
    await findRectangles(contours, mat),
    mat.cols
  ).reverse();

  displayRectangles(rectengles, ctx);

  // recognize text
  const texts = [];

  for await (const rect of rectengles) {
    const text = await recognizeText(img, rect);
    texts.push(text);
  }

  console.log(texts);

  mat.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();
};
const findRectangles = async (contours, mat) => {
  const rectangles = [];

  for (let i = 0; i < contours.size(); ++i) {
    const contour = contours.get(i);
    const rect = cv.boundingRect(contour);

    const roi = mat.roi(rect);

    try {
      const dominantColor = await calculateDominantColor(roi);

      const absDiffRedGreen = Math.abs(dominantColor.red - dominantColor.green);
      const absDiffGreenBlue = Math.abs(
        dominantColor.green - dominantColor.blue
      );
      const absDiffRedBlue = Math.abs(dominantColor.red - dominantColor.blue);

      if (rect.height < mat.cols / 12 || rect.width / rect.height < 1 / 3) {
        continue;
      }

      // if it's too close to 1:1 ratio, it's probably not a text (it's a square or a circle)
      if (rect.width / rect.height < 1.3) {
        // Check dominant color condition
        if (
          dominantColor.red > 240 &&
          dominantColor.green > 240 &&
          dominantColor.blue > 240
        ) {
          continue;
        } else if (
          absDiffRedGreen < 60 &&
          absDiffGreenBlue < 60 &&
          absDiffRedBlue < 60
        ) {
          continue;
        }
      }

      // if rectangle is equal or near the size of the image, it's probably not a text
      if (rect.width >= mat.cols - 10) {
        continue;
      }

      if (
        rect.width >= MIN_RECTANGLE_WIDTH &&
        rect.height >= MIN_RECTANGLE_HEIGHT
      ) {
        const dividerYCoordinates = [];

        const grayscaleRoi = new cv.Mat();
        cv.cvtColor(roi, grayscaleRoi, cv.COLOR_RGBA2GRAY, 0);
        // Loop through all pixels of grayscale ROI
        for (let y = 10; y < grayscaleRoi.rows; y++) {
          let consecutiveWhitePixels = 0;
          if (
            dividerYCoordinates.length == 0 ||
            dividerYCoordinates[dividerYCoordinates.length - 1] < y - 15
          ) {
            for (
              let x = Math.round(grayscaleRoi.cols / 3);
              x < grayscaleRoi.cols;
              x++
            ) {
              // Check if pixel is white (considering 95% white)
              if (grayscaleRoi.ucharPtr(y, x)[0] >= 241) {
                consecutiveWhitePixels++;
                if (consecutiveWhitePixels >= 15) {
                  // Save the y coordinate as a divider
                  dividerYCoordinates.push(y);
                  break;
                }
              } else {
                break;
              }
            }
          }
        }

        if (dividerYCoordinates.length == 0) {
          rectangles.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            endX: rect.x + rect.width,
          });
        } else {
          const rectanglesTemp = [];
          let lastStart = 0;
          for (let i = 0; i < dividerYCoordinates.length; i++) {
            if (dividerYCoordinates[i] - lastStart > mat.cols / 12) {
              rectanglesTemp.push({
                x: rect.x,
                y: rect.y + lastStart,
                width: rect.width,
                height: dividerYCoordinates[i] - lastStart,
                endX: rect.x + rect.width,
              });
            }
            lastStart = dividerYCoordinates[i];
          }
          if (rect.height - lastStart > mat.cols / 12) {
            rectanglesTemp.push({
              x: rect.x,
              y: rect.y + lastStart,
              width: rect.width,
              height: rect.height - lastStart,
              endX: rect.x + rect.width,
            });
          }
          // first reverse temp array:
          rectanglesTemp.reverse();
          rectangles.push(...rectanglesTemp);
        }

        grayscaleRoi.delete();
      }
    } catch (error) {
      console.error("Error:", error);
    }

    roi.delete();
  }
  // Iterate through sorted rectangles to check overlapping y-coordinates
  for (let i = 0; i < rectangles.length - 1; i++) {
    const currentRect = rectangles[i];
    const nextRect = rectangles[i + 1];
    const currentRectmidY = currentRect.y + currentRect.height / 2;

    // If the middle point of current rectangle is between the y start and end coordinates of the next rectangle
    if (
      currentRectmidY >= nextRect.y &&
      currentRectmidY <= nextRect.y + nextRect.height
    ) {
      // Remove the rectangle with the smaller width
      if (currentRect.width < nextRect.width) {
        rectangles.splice(i, 1);
        i--; // Decrement index as the array length has decreased
      } else {
        rectangles.splice(i + 1, 1);
      }
    }
  }

  return rectangles;
};

// Function to calculate dominant color within a region of interest (ROI)
function calculateDominantColor(roi) {
  return new Promise((resolve, reject) => {
    // Convert the ROI to a canvas
    const canvas = document.createElement("canvas");
    canvas.width = roi.cols;
    canvas.height = roi.rows;
    cv.imshow(canvas, roi);

    // Get the data URL from the canvas
    const dataUrl = canvas.toDataURL();

    // Create an image element
    const img = new Image();

    // Set the source of the image element to the data URL
    img.src = dataUrl;

    // When the image loads, draw it onto a hidden canvas and extract the pixel color data
    img.onload = () => {
      const hiddenCanvas = document.createElement("canvas");
      hiddenCanvas.width = 1;
      hiddenCanvas.height = 1;
      const ctx = hiddenCanvas.getContext("2d");
      ctx.drawImage(img, 0, 0, 1, 1);

      // Get the pixel color data
      const imageData = ctx.getImageData(0, 0, 1, 1).data;
      const red = imageData[0];
      const green = imageData[1];
      const blue = imageData[2];

      // Construct the dominant color object
      const dominantColor = {
        red: red,
        green: green,
        blue: blue,
      };

      // Resolve the promise with the dominant color
      resolve(dominantColor);
    };

    // If there's an error loading the image, reject the promise
    img.onerror = (error) => {
      reject(error);
    };
  });
}

const groupRectangles = (rectangles, width) => {
  const scaleFactor = width / 150;
  console.log(scaleFactor);
  console.log(X_THRESHOLD_FOR_GROUPING);
  console.log(X_THRESHOLD_FOR_GROUPING * scaleFactor);
  console.log("------------");

  return rectangles.map((rect) => ({
    ...rect,
    group:
      rect.x > X_THRESHOLD_FOR_GROUPING * scaleFactor &&
      rect.endX < width - X_THRESHOLD_FOR_GROUPING * scaleFactor
        ? "NONE"
        : width - rect.endX > rect.x
        ? "LEFT"
        : "RIGHT",
  }));
};

const displayRectangles = (rectangles, ctx) => {
  rectangles.forEach((rect) => {
    const color = DEBUG_COLORS[rect.group];

    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = color;
    ctx.strokeWidth = 2;
    ctx.stroke();

    // write informations on the rectangle

    ctx.fillStyle = color;
    ctx.font = "24px Helvetica";
    ctx.fillText(rect.group, rect.x, rect.y - 16);
    ctx.font = "12px Helvetica";
    ctx.fillText(
      `(${rect.x}, ${rect.y}, ${rect.endX})`,
      rect.x,
      rect.y + rect.height + 16
    );
  });
};

const recognizeText = async (img, rect) => {
  const {
    data: { text },
  } = await worker.recognize(img, {
    rectangle: {
      top: rect.y,
      left: rect.x,
      width: rect.width,
      height: rect.height,
    },
  });

  return {
    message: text,
    side: rect.group,
  };
};

const debug = () => {
  debugMode = !debugMode;
  document.getElementById("ocrCanvas").style.display = debugMode
    ? "block"
    : "none";
};

const naturalCompare = (a, b) => {
  return new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  }).compare(a, b);
};
