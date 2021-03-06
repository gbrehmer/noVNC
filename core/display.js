/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC Authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 */

import * as Log from './util/logging.js';
import Base64 from "./base64.js";
import { toSigned32bit } from './util/int.js';

export default class Display {
    constructor(target, rotate) {
        this._drawCtx = null;

        this._renderQ = [];  // queue drawing actions for in-oder rendering
        this._flushing = false;

        // the full frame buffer (logical canvas) size
        this._fbWidth = 0;
        this._fbHeight = 0;
        this._rotate = rotate;

        this._prevDrawStyle = "";

        Log.Debug(">> Display.constructor");

        // The visible canvas
        this._target = target;

        if (!this._target) {
            throw new Error("Target must be set");
        }

        if (typeof this._target === 'string') {
            throw new Error('target must be a DOM element');
        }

        if (!this._target.getContext) {
            throw new Error("no getContext method");
        }

        this._targetCtx = this._target.getContext('2d');

        // the visible canvas viewport (i.e. what actually gets seen)
        this._viewportLoc = { 'x': 0, 'y': 0, 'w': this._target.width, 'h': this._target.height };

        // The hidden canvas, where we do the actual rendering
        this._backbuffer = document.createElement('canvas');
        this._drawCtx = this._backbuffer.getContext('2d');

        if (this._rotate === 'left' || this._rotate === 'right') {
            this._damageBounds = {
                left: 0, top: 0,
                right: this._backbuffer.height,
                bottom: this._backbuffer.width
            };
        } else {
            this._damageBounds = {
                left: 0, top: 0,
                right: this._backbuffer.width,
                bottom: this._backbuffer.height
            };
        }

        Log.Debug("<< Display.constructor");

        // ===== PROPERTIES =====

        this._scale = 1.0;
        this._clipViewport = false;

        // ===== EVENT HANDLERS =====

        this.onflush = () => {}; // A flush request has finished
    }

    // ===== PROPERTIES =====

    get rotate() { return this._rotate; }
    set rotate(rotate) {
        this._rotate = rotate;
    }

    get scale() { return this._scale; }
    set scale(scale) {
        this._rescale(scale);
    }

    get clipViewport() { return this._clipViewport; }
    set clipViewport(viewport) {
        this._clipViewport = viewport;
        // May need to readjust the viewport dimensions
        const vp = this._viewportLoc;
        this.viewportChangeSize(vp.w, vp.h);
        this.viewportChangePos(0, 0);
    }

    get width() {
        return this._fbWidth;
    }

    get height() {
        return this._fbHeight;
    }

    // ===== PUBLIC METHODS =====

    viewportChangePos(deltaX, deltaY) {
        const vp = this._viewportLoc;
        deltaX = Math.floor(deltaX);
        deltaY = Math.floor(deltaY);

        if (!this._clipViewport) {
            deltaX = -vp.w;  // clamped later of out of bounds
            deltaY = -vp.h;
        }

        const vx2 = vp.x + vp.w - 1;
        const vy2 = vp.y + vp.h - 1;

        // Position change

        if (deltaX < 0 && vp.x + deltaX < 0) {
            deltaX = -vp.x;
        }
        if (vx2 + deltaX >= this._fbWidth) {
            deltaX -= vx2 + deltaX - this._fbWidth + 1;
        }

        if (vp.y + deltaY < 0) {
            deltaY = -vp.y;
        }
        if (vy2 + deltaY >= this._fbHeight) {
            deltaY -= (vy2 + deltaY - this._fbHeight + 1);
        }

        if (deltaX === 0 && deltaY === 0) {
            return;
        }
        Log.Debug("viewportChange deltaX: " + deltaX + ", deltaY: " + deltaY);

        vp.x += deltaX;
        vp.y += deltaY;

        this._damage(vp.x, vp.y, vp.w, vp.h);

        this.flip();
    }

    viewportChangeSize(width, height) {

        if (!this._clipViewport ||
            typeof(width) === "undefined" ||
            typeof(height) === "undefined") {

            Log.Debug("Setting viewport to full display region");
            width = this._fbWidth;
            height = this._fbHeight;
        }

        width = Math.floor(width);
        height = Math.floor(height);

        if (width > this._fbWidth) {
            width = this._fbWidth;
        }
        if (height > this._fbHeight) {
            height = this._fbHeight;
        }

        const vp = this._viewportLoc;
        if (vp.w !== width || vp.h !== height) {
            vp.w = width;
            vp.h = height;

            const canvas = this._target;
            canvas.width = width;
            canvas.height = height;

            // The position might need to be updated if we've grown
            this.viewportChangePos(0, 0);

            this._damage(vp.x, vp.y, vp.w, vp.h);
            this.flip();

            // Update the visible size of the target canvas
            this._rescale(this._scale);
        }
    }

    absX(x) {
        if (this._scale === 0) {
            return 0;
        }
        return toSigned32bit(x / this._scale + this._viewportLoc.x);
    }

    absY(y) {
        if (this._scale === 0) {
            return 0;
        }
        return toSigned32bit(y / this._scale + this._viewportLoc.y);
    }

    resize(width, height) {
        this._prevDrawStyle = "";

        this._fbWidth = width;
        this._fbHeight = height;

        const canvas = this._backbuffer;
        if (canvas.width !== width || canvas.height !== height) {

            // We have to save the canvas data since changing the size will clear it
            let saveImg = null;
            if (canvas.width > 0 && canvas.height > 0) {
                saveImg = this._drawCtx.getImageData(0, 0, canvas.width, canvas.height);
            }

            if (canvas.width !== width) {
                canvas.width = width;
            }
            if (canvas.height !== height) {
                canvas.height = height;
            }

            if (saveImg) {
                this._drawCtx.putImageData(saveImg, 0, 0);
            }
        }

        // Readjust the viewport as it may be incorrectly sized
        // and positioned
        const vp = this._viewportLoc;
        this.viewportChangeSize(vp.w, vp.h);
        this.viewportChangePos(0, 0);
    }

    // Track what parts of the visible canvas that need updating
    _damage(x, y, w, h) {
        if (x < this._damageBounds.left) {
            this._damageBounds.left = x;
        }
        if (y < this._damageBounds.top) {
            this._damageBounds.top = y;
        }
        if ((x + w) > this._damageBounds.right) {
            this._damageBounds.right = x + w;
        }
        if ((y + h) > this._damageBounds.bottom) {
            this._damageBounds.bottom = y + h;
        }
    }

    // Update the visible canvas with the contents of the
    // rendering canvas
    flip(fromQueue) {
        if (this._renderQ.length !== 0 && !fromQueue) {
            this._renderQPush({
                'type': 'flip'
            });
        } else {
            let x = this._damageBounds.left;
            let y = this._damageBounds.top;
            let w = this._damageBounds.right - x;
            let h = this._damageBounds.bottom - y;

            let vx = x - this._viewportLoc.x;
            let vy = y - this._viewportLoc.y;

            if (vx < 0) {
                w += vx;
                x -= vx;
                vx = 0;
            }
            if (vy < 0) {
                h += vy;
                y -= vy;
                vy = 0;
            }

            if ((vx + w) > this._viewportLoc.w) {
                w = this._viewportLoc.w - vx;
            }
            if ((vy + h) > this._viewportLoc.h) {
                h = this._viewportLoc.h - vy;
            }

            if ((w > 0) && (h > 0)) {
                // FIXME: We may need to disable image smoothing here
                //        as well (see copyImage()), but we haven't
                //        noticed any problem yet.
                this._targetCtx.drawImage(this._backbuffer,
                                          x, y, w, h,
                                          vx, vy, w, h);
            }

            this._damageBounds.left = this._damageBounds.top = 65535;
            this._damageBounds.right = this._damageBounds.bottom = 0;
        }
    }

    pending() {
        return this._renderQ.length > 0;
    }

    flush() {
        if (this._renderQ.length === 0) {
            this.onflush();
        } else {
            this._flushing = true;
        }
    }

    fillRect(x, y, width, height, color, fromQueue) {
        if (this._renderQ.length !== 0 && !fromQueue) {
            this._renderQPush({
                'type': 'fill',
                'x': x,
                'y': y,
                'width': width,
                'height': height,
                'color': color
            });
        } else {
            this._setFillColor(color);
            let x0;
            let y0;
            let w0;
            let h0;
            if (this._rotate === 'right') {
                y0 = x;
                x0 = this._fbWidth - y - 1 - height;
                w0 = height;
                h0 = width;
            } else if (this._rotate === 'left') {
                y0 = this._fbHeight - x - 1 - width;
                x0 = y;
                w0 = height;
                h0 = width;
            } else if (this._rotate === 'double') {
                x0 = this._fbWidth - x - 1 - width;
                y0 = this._fbHeight - y - 1 - height;
                w0 = width;
                h0 = height;
            } else {
                x0 = x;
                y0 = y;
                w0 = width;
                h0 = height;
            }
            this._drawCtx.fillRect(x0, y0, w0, h0);
            this._damage(x0, y0, w0, h0);
        }
    }

    copyImage(oldX, oldY, newX, newY, w, h, fromQueue) {
        if (this._renderQ.length !== 0 && !fromQueue) {
            this._renderQPush({
                'type': 'copy',
                'oldX': oldX,
                'oldY': oldY,
                'x': newX,
                'y': newY,
                'width': w,
                'height': h,
            });
        } else {
            // Due to this bug among others [1] we need to disable the image-smoothing to
            // avoid getting a blur effect when copying data.
            //
            // 1. https://bugzilla.mozilla.org/show_bug.cgi?id=1194719
            //
            // We need to set these every time since all properties are reset
            // when the the size is changed
            this._drawCtx.mozImageSmoothingEnabled = false;
            this._drawCtx.webkitImageSmoothingEnabled = false;
            this._drawCtx.msImageSmoothingEnabled = false;
            this._drawCtx.imageSmoothingEnabled = false;

            let a = 0;
            if (this._rotate === 'right') {
                a = oldX;
                oldX = this._fbWidth - oldY - 1 - h;
                oldY = a;
                a = newX;
                newX = this._fbWidth - newY - 1;
                newY = a;
            } else if (this._rotate === 'left') {
                a = oldY;
                oldY = this._fbHeight - oldX - 1 - w;
                oldX = a;
                a = newY;
                newY = this._fbHeight - newX - 1;
                newX = a;
            } else if (this._rotate === 'double') {
                oldY = this._fbHeight - oldY - 1 - h;
                oldX = this._fbWidth - oldX - 1 - w;
                newY = this._fbHeight - newY - 1;
                newX = this._fbWidth - newX - 1;
            }
            this._drawCtx.drawImage(this._backbuffer,
                                    oldX, oldY, w, h,
                                    newX, newY, w, h);
            this._damage(newX, newY, w, h);
        }
    }

    imageRect(x, y, width, height, mime, arr) {
        /* The internal logic cannot handle empty images, so bail early */
        if ((width === 0) || (height === 0)) {
            return;
        }

        const img = new Image();
        img.src = "data: " + mime + ";base64," + Base64.encode(arr);

        this._renderQPush({
            'type': 'img',
            'img': img,
            'x': x,
            'y': y,
            'width': width,
            'height': height
        });
    }

    blitImage(x, y, width, height, arr, offset, fromQueue) {
        if (this._renderQ.length !== 0 && !fromQueue) {
            // NB(directxman12): it's technically more performant here to use preallocated arrays,
            // but it's a lot of extra work for not a lot of payoff -- if we're using the render queue,
            // this probably isn't getting called *nearly* as much
            const newArr = new Uint8Array(width * height * 4);
            newArr.set(new Uint8Array(arr.buffer, 0, newArr.length));
            this._renderQPush({
                'type': 'blit',
                'data': newArr,
                'x': x,
                'y': y,
                'width': width,
                'height': height,
            });
        } else {
            let data = null;
            if (this._rotate === 'left' || this._rotate === 'right') {
                data = new Uint8ClampedArray(4 * width * height);
            } else {
                data = new Uint8ClampedArray(arr.buffer,
                                             arr.byteOffset + offset,
                                             width * height * 4);
            }
            let img = new ImageData(data, width, height);

            if (this._rotate === 'right') {
                let j = offset;
                for (let yv = 0; yv < height; yv++) {
                    for (let xv = 0; xv < width; xv++) {
                        let doff = ((xv * height) + (width - yv - 1)) * 4;
                        data[doff]     = arr[j];
                        data[doff + 1] = arr[j + 1];
                        data[doff + 2] = arr[j + 2];
                        data[doff + 3] = 255;  // Alpha
                        j += 4;
                    }
                }
            } else if (this._rotate === 'left') {
                let j = offset;
                for (let yv = height - 1; yv >= 0; yv--) {
                    for (let xv = width - 1; xv >= 0; xv--) {
                        let doff = ((xv * height) + (width - yv - 1)) * 4; //((height - xv - 1) + (width * yv)) * 4;
                        data[doff]     = arr[j];
                        data[doff + 1] = arr[j + 1];
                        data[doff + 2] = arr[j + 2];
                        data[doff + 3] = 255;  // Alpha
                        j += 4;
                    }
                }
            } else if (this._rotate === 'double') {
                let length = width * height * 4;
                for (let i = 4, j = offset; i <= length; i += 4, j += 4) {
                    data[length - i]     = arr[j];
                    data[length - i + 1] = arr[j + 1];
                    data[length - i + 2] = arr[j + 2];
                    data[length - i + 3] = 255;  // Alpha
                }
            }
            let x0 = x;
            let y0 = y;
            if (this._rotate === 'right') {
                let a = x0;
                x0 = this._fbWidth - y0 - 1 - height;
                y0 = a;
            } else if (this._rotate === 'left') {
                let a = y0;
                y0 = this._fbHeight - x0 - 1 - width;
                x0 = a;
            } else if (this._rotate === 'double') {
                y0 = this._fbHeight - y0 - 1 - height;
                x0 = this._fbWidth - x0 - 1 - width;
            }
            this._drawCtx.putImageData(img, x0, y0);
            this._damage(x0, y0, img.width, img.height);
        }
    }

    drawImage(img, x, y) {
        let x0 = x;
        let y0 = y;
        let a = 0;
        if (this._rotate === 'right') {
            a = x0;
            x0 = this._fbWidth - y0;
            y0 = a;
        } else if (this._rotate === 'left') {
            a = y0;
            y0 = this._fbHeight - x0;
            x0 = a;
        } else if (this._rotate === 'double') {
            y0 = this._fbHeight - y0;
            x0 = this._fbWidth - x0;
        }
        this._drawCtx.drawImage(img, x0, y0);
        this._damage(x0, y0, img.width, img.height);
    }

    autoscale(containerWidth, containerHeight) {
        let scaleRatio;

        if (containerWidth === 0 || containerHeight === 0) {
            scaleRatio = 0;

        } else {

            const vp = this._viewportLoc;
            const targetAspectRatio = containerWidth / containerHeight;
            const fbAspectRatio = vp.w / vp.h;

            if (fbAspectRatio >= targetAspectRatio) {
                scaleRatio = containerWidth / vp.w;
            } else {
                scaleRatio = containerHeight / vp.h;
            }
        }

        this._rescale(scaleRatio);
    }

    // ===== PRIVATE METHODS =====

    _rescale(factor) {
        this._scale = factor;
        const vp = this._viewportLoc;

        // NB(directxman12): If you set the width directly, or set the
        //                   style width to a number, the canvas is cleared.
        //                   However, if you set the style width to a string
        //                   ('NNNpx'), the canvas is scaled without clearing.
        const width = factor * vp.w + 'px';
        const height = factor * vp.h + 'px';

        if ((this._target.style.width !== width) ||
            (this._target.style.height !== height)) {
            this._target.style.width = width;
            this._target.style.height = height;
        }
    }

    _setFillColor(color) {
        const newStyle = 'rgb(' + color[0] + ',' + color[1] + ',' + color[2] + ')';
        if (newStyle !== this._prevDrawStyle) {
            this._drawCtx.fillStyle = newStyle;
            this._prevDrawStyle = newStyle;
        }
    }

    _renderQPush(action) {
        this._renderQ.push(action);
        if (this._renderQ.length === 1) {
            // If this can be rendered immediately it will be, otherwise
            // the scanner will wait for the relevant event
            this._scanRenderQ();
        }
    }

    _resumeRenderQ() {
        // "this" is the object that is ready, not the
        // display object
        this.removeEventListener('load', this._noVNCDisplay._resumeRenderQ);
        this._noVNCDisplay._scanRenderQ();
    }

    _scanRenderQ() {
        let ready = true;
        while (ready && this._renderQ.length > 0) {
            const a = this._renderQ[0];
            switch (a.type) {
                case 'flip':
                    this.flip(true);
                    break;
                case 'copy':
                    this.copyImage(a.oldX, a.oldY, a.x, a.y, a.width, a.height, true);
                    break;
                case 'fill':
                    this.fillRect(a.x, a.y, a.width, a.height, a.color, true);
                    break;
                case 'blit':
                    this.blitImage(a.x, a.y, a.width, a.height, a.data, 0, true);
                    break;
                case 'img':
                    if (a.img.complete) {
                        if (a.img.width !== a.width || a.img.height !== a.height) {
                            Log.Error("Decoded image has incorrect dimensions. Got " +
                                      a.img.width + "x" + a.img.height + ". Expected " +
                                      a.width + "x" + a.height + ".");
                            return;
                        }
                        this.drawImage(a.img, a.x, a.y);
                    } else {
                        a.img._noVNCDisplay = this;
                        a.img.addEventListener('load', this._resumeRenderQ);
                        // We need to wait for this image to 'load'
                        // to keep things in-order
                        ready = false;
                    }
                    break;
            }

            if (ready) {
                this._renderQ.shift();
            }
        }

        if (this._renderQ.length === 0 && this._flushing) {
            this._flushing = false;
            this.onflush();
        }
    }
}
