let cheerio = require("cheerio");
let request = require("request");
let sqlite3 = require("sqlite3").verbose();
let pdf2json = require("pdf2json");
let UrlParser = require("url");

// Sets up an sqlite database.

function initializeDatabase(callback) {
    let database = new sqlite3.Database("data.sqlite");
    database.serialize(() => {
        database.run("create table if not exists [data] ([name] text)");
        callback(database);
    });
}

// Inserts a row into the database.

function insertRow(database, value) {
    let sqlStatement = database.prepare("insert into [data] values (?)");
    sqlStatement.run(value);
    sqlStatement.finalize();
}

// Reads rows from the database.

function readRows(database) {
    database.each("select [rowid] as [id], [name] from [data]", (error, row) => {
        console.log(row.id + ": " + row.name);
    });
}

// Reads a page using request.
    
function requestPage(url, callback) {
    console.log(`Requesting page: ${url}`);
    request(url.href, (error, response, body) => {
        if (error) {
            console.log(`Error requesting page ${url}: ${error}`);
            return;
        }
        callback(body);
    });
}

// Reads and parses the development application web pages.

function run(database) {
    // Read the lodged applications page.
    
    let url = new UrlParser.URL("https://www.campbelltown.sa.gov.au/page.aspx?u=1973");
    requestPage(url, body => {
        // Use cheerio to find all URLs that refer to PDFs.
 
        let $ = cheerio.load(body);
        $("div.uContentList a").each((index, element) => {
            let baseUrl = url.origin + url.pathname;
            let pdfUrl = new UrlParser.URL(element.attribs.href, baseUrl);
            console.log(`Reading PDF from URL: ${pdfUrl}`)

            // let testPdf = pdfjs.getDocument(pdfUrl.href).then(pdf => {
            //     console.log(pdf);
            //     let pagePromises = [];
            //     for (let pageNumber = 1; pageNumber <= pdf.pdfInfo.numPages; pageNumber++) {
            //         let page = pdf.getPage(pageNumber);
            //         pagePromises.push(page.then(page => {
            //             return page.getTextContent().then(textContent => {
            //                 let text = "";
            //                 let previousItem = null;
            //                 for (let item of textContent.items) {
            //                     //if (previousItem !== null && previousItem.str[previousItem.length - 1] !== ' ') {
            //                     //    if (item.x < previousItem.x)
            //                     //        text += "\r\n";
            //                     //    else if (previousItem.y !== item.y && previousItem.str.match(/^(\s?[a-zA-Z])$|^(.+\s[a-zA-Z])$/) === null)
            //                     //        text += " ";
            //                     //}
            //                     text += item.str + "\r\n";
            //                     previousItem = item;
            //                 }
            //                 return text + "\r\n";
            //             })
            //         }))
            //     }
            //     Promise.all(pagePromises).then(texts => texts.join("")).then(text => {
            //         console.log(text);
            //     })
            // });

            let pdfParser = new pdf2json();
            let pdfPipe = request({ url: pdfUrl.href, encoding: null }).pipe(pdfParser);
            pdfPipe.on("pdfParser_dataError", error => {
                console.error(error);
            });
            pdfPipe.on("pdfParser_dataReady", pdf => {
                let pdfRows = convertPdfToTable(pdf);

                // let text = pdfParser.getMergedTextBlocksIfNeeded();
                // // let text = pdfParser.getMergedTextBlocksIfNeeded();
                // for (let page of pdf.formImage.Pages) {
                //     // Parse text of PDF to extract development application details ...
                //     // insertRow(database, value);
                // }
                console.log(`Parsed PDF ${pdfUrl}.`);
            });
        });
        readRows(database);
        // database.close();
    });

    return;

    // Read the approved applications page.
        
    requestPage("https://www.campbelltown.sa.gov.au/page.aspx?u=1777", body => {
        // Use cheerio to find things in the page with css selectors.
        
        let $ = cheerio.load(body);
        $("div.uContentList a").each(() => {
            let value = $(this).text().trim();
            insertRow(database, value);
        });
        readRows(database);
        // database.close();
    });
}

// Convert a PDF to a table.  This is based on pdf2table by Sam Decrock.
// https://github.com/SamDecrock/pdf2table/blob/master/lib/pdf2table.js.

function convertPdfToTable(pdf) {
    var comparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);

    // Find the smallest y value between two texts with equal x values.

    var smallestYValueForPage = [];

    for (var p = 0; p < pdf.formImage.Pages.length; p++) {
        var page = pdf.formImage.Pages[p];
        var smallestYValue = null;  // per page
        var textsWithSameXvalues = {};

        for (var t = 0; t < page.Texts.length; t++) {
            var text = page.Texts[t];
            if(!textsWithSameXvalues[text.x])
                textsWithSameXvalues[text.x] = [];
            textsWithSameXvalues[text.x].push(text);
        }

        // Find smallest y distance.

        for (var x in textsWithSameXvalues) {
            var texts = textsWithSameXvalues[x];
            for (var i = 0; i < texts.length; i++) {
                var firstYvalue = texts[i].y;
                for (var j = 0; j < texts.length; j++) {
                    if (texts[i] !== texts[j]) {
                        var distance = Math.abs(texts[j].y - texts[i].y);
                        if (smallestYValue === null || distance < smallestYValue)
                            smallestYValue = distance;
                    }
                };
            };
        }

        if (smallestYValue === null)
            smallestYValue = 0;
        smallestYValueForPage.push(smallestYValue);
    }

    // Find texts with similar y values (in the range of y - smallestYValue to y + smallestYValue).

    var myPages = [];

    for (var p = 0; p < pdf.formImage.Pages.length; p++) {
        var page = pdf.formImage.Pages[p];

        var rows = [];  // store texts and their x positions in rows

        for (var t = 0; t < page.Texts.length; t++) {
            var text = page.Texts[t];

            var foundRow = false;
            for (var r = rows.length - 1; r >= 0; r--) {
                // y value of Text falls within the y-value range, add text to row.
                var maxYdifference = smallestYValueForPage[p];
                if (rows[r].y - maxYdifference < text.y && text.y < rows[r].y + maxYdifference) {
                    // Only add value of T to data (which is the actual text).
                    for (var i = 0; i < text.R.length; i++)
                        rows[r].data.push({ text: decodeURIComponent(text.R[i].T), x: text.x });
                    foundRow = true;
                }
            };

            if (!foundRow) {
                // Create new row.
                var row = { y: text.y, data: [] };

                // Add text to row.
                for (var index = 0; index < text.R.length; index++)
                    row.data.push({ text: decodeURIComponent(text.R[index].T), x: text.x });

                // add row to rows:
                rows.push(row);
            }
        };

        // Sort each extracted row.

        for (var index = 0; index < rows.length; index++)
            rows[index].data.sort(comparer);

        // Add rows to pages.

        myPages.push(rows);
    };

    // Flatten pages into rows.

    var rows = [];

    for (var p = 0; p < myPages.length; p++) {
        for (var r = 0; r < myPages[p].length; r++) {
            // Now that each row is made of objects extract the text property from the object.

            var rowEntries = []
            var row = myPages[p][r].data;
            for (var index = 0; index < row.length; index++)
                rowEntries.push(row[index].text);

            // Append the extracted and ordered text into the return rows.

            rows.push(rowEntries);
        };
    };

    return rows;
}

initializeDatabase(run);
