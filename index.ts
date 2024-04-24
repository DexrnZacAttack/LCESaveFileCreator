import { readdir, readFile, writeFile, stat } from "fs/promises";
import { join, resolve, relative } from "path";

// This is not final, as this will be built for the browser later.
const path2Folder: string = resolve(process.argv[2]!);

// This doesn't change ATM... TODO: Make this variable between console types, also make it an enum for console types, as different consoles use different compression.
const zlib = true;

/**
 * This is the number of bytes that the header takes up, which is 8 (4 bytes offset, 4 bytes count.)
*/
export const headerLength: number = 8;

/**
 * This is the number of bytes that an entry in the index takes up, which is 144.
*/
export const indexEntryLength: number = 144

/**
 * This contains the current file's name.
 * When setting this, I switch the paths from Windows style to Unix style as that's how the save format does folders.
 */
let uFileName!: string;

/**
 * This contains the current file's name, but encoded in bytes. (essentially a char array I think)
 */
let encodedUFileName!: Uint8Array;

/**
 * This is used to encode the filenames for the index.
 */
const textEncoder = new TextEncoder();

async function read() {
    /**
     * Thanks to Offroaders123 for this!
     * I'll let him explain it since he knows what this does better than I do.
     */
    const entries: File[] = await Promise.all(
        (
            await readdir(path2Folder, { recursive: true, withFileTypes: true })
        )
            .filter((dirent) => dirent.isFile())
            .map(async (dirent) => {
                const absolutePath: string = join(dirent.path, dirent.name);
                const data: Buffer = await readFile(absolutePath);
                const { mtimeMs } = await stat(absolutePath);
                const relativePath: string = relative(path2Folder, absolutePath);
                return new File([data], relativePath, { lastModified: mtimeMs });
            })
    );
    const files: [File, Buffer][] = await Promise.all(
        entries.map(async (path) => [
            path,
            await readFile(`${path2Folder}\\` + path.name),
        ])
    );
    generateSave(files);
}

export async function generateSave(files: [File, Buffer][]) {
    /**
     * This is used to keep track of what file we are on... only used in one place though. (sgCurrentFileOffset)
    */
    let fIndex: number = 0;
    
    /**
     * This is the number of bytes (the length) of every file combined.
    */
    const filesLength: number = files.reduce(
        (previous, [name, file]) => previous + file.byteLength,
        0
    );

    /**
     * This is the first part of the 8 byte header containing the offset of the index in the savegame... the index is what holds all of the file names and their info.
     */
    const offset: number = filesLength + headerLength;

    /**
     * This is the second part of the 8 byte header containing the number of files that is in the index.
     */
    const count: number = files.length;

    console.log(`There are ${count} files in the folder, of which take up ${filesLength} bytes space.`);
    /**
     * This is used to keep track of where we are in the stream.
     * Unfortunately, Buffer's write functions don't increment anywhere... so we have to do it manually,
     * which makes this code look a lot uglier.
     */
    let currentOffset: number = headerLength;

    /**
     * This is the Buffer object that contains the bytes of the savegame that we are creating.
     * I called it OutputStream because I liked the name better lol.
     */
    const sgOutputStream = Buffer.alloc(filesLength + headerLength + indexEntryLength * count);

    /**
     * For each file in the index, we keep an offset that says where the file starts, we use fIndex to see each file's offset.
     */
    let sgCurrentFileOffset: Array<number> = [];
    // Write the files to the save.
    for (const [fileObj, file] of files) {
        uFileName = fileObj.name.replace("\\", "/");
        encodedUFileName = textEncoder.encode(uFileName);
        if (encodedUFileName.length !== 0) {
            sgCurrentFileOffset.push(currentOffset);
            console.log(`Writing ${uFileName}...`);
            // for every byte in the file, write said byte.
            file.forEach((byte) => {
                sgOutputStream.writeUInt8(byte, currentOffset);
                currentOffset += 1;
            });
        } else {
            // if the file's name is blank... don't bother writing it, as there may be something wrong with the file.
            console.log("File has no name... skipping!");
        }
    }

    // Write offset and count to start of file
    sgOutputStream.writeUInt32BE(offset, 0);
    sgOutputStream.writeUInt32BE(count, 4);

    // Write index entries
    for (const [fileObj, file] of files) {

        uFileName = fileObj.name.replace("\\", "/");
        encodedUFileName = textEncoder.encode(uFileName);
        // if the filename doesn't have a name, don't write it... otherwise write it.
        if (encodedUFileName.length !== 0) {
            console.log(`Writing "${uFileName}" to index...`);
            // Write the file name in UTF16 (janky!)
            encodedUFileName.forEach((byte) => {
                sgOutputStream.writeUInt8(0, currentOffset);
                currentOffset += 1;
                sgOutputStream.writeUInt8(byte, currentOffset);
                currentOffset += 1;
            });
            // add a shit ton of 0s before adding the rest of the info
            for (var i: number = 0; i < 128 - encodedUFileName.length * 2; i++) {
                sgOutputStream.writeUint8(0, currentOffset);
                currentOffset += 1;
            }
            // File Length
            sgOutputStream.writeUInt32BE(file.length ?? 0, currentOffset);
            currentOffset += 4;
            // File Offset
            if (file.length !== 0)
                sgOutputStream.writeUInt32BE(sgCurrentFileOffset[fIndex] ?? 0, currentOffset);
            else
                sgOutputStream.writeUInt32BE(0, currentOffset);
            currentOffset += 4;
            // File Timestamp (Thanks to PhoenixARC for helping me find out what this is!)
            sgOutputStream.writeBigUInt64BE(BigInt(Date.now()), currentOffset);
            currentOffset += 8;
            fIndex++;
        } else {
            console.log("File has no name... unable to add to index!");
        }
    }
    // If zlib is true, compress the file the same way the Wii U does it (ZLib with 8 bytes of header of uncompressed data length)
    if (zlib == true) {
        console.log("Compressing with ZLIB");
        /**
         * This is where we are in the deflateBuffer, as we need to be able to write a header and the save to it.
         */
        var dbCurOffset: number = 0;
        /**
         * This contains the save data but ZLib compressed.
         */
        const deflateStream = require("zlib").deflateSync(sgOutputStream);
        /** This is the Buffer that we will write the header and ZLib'd data into. */
        const deflateBuffer: Buffer = Buffer.alloc(deflateStream.length + 8);
        // Write header (which is the length of the uncompressed save)
        deflateBuffer.writeBigUInt64BE(BigInt(sgOutputStream.length), dbCurOffset);
        dbCurOffset += 8;
        // write all of the ZLib compressed save data to the buffer.
        for (var i3: number = 0; i3 < deflateStream.length; i3++) {
            deflateBuffer.writeUint8(deflateStream[i3], dbCurOffset);
            dbCurOffset++;
        }
        // Save the file.
        await writeFile("sg_zlib.dat", deflateBuffer);
    } else {
        // Save the file.
        await writeFile("sg.dat", sgOutputStream);
    }
    console.log("Saved!");
}

read();