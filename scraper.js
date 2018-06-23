let cheerio = require("cheerio");
let request = require("request");
let sqlite3 = require("sqlite3").verbose();
let pdf2json = require("pdf2json");

function initDatabase(callback) {
    // Set up sqlite database.
    
    let db = new sqlite3.Database("data.sqlite");
    db.serialize(() => {
        db.run("create table if not exists [data] ([name] text)");
        callback(db);
    });
}

function updateRow(db, value) {
    // Insert some data.
    
    let statement = db.prepare("insert into [data] values (?)");
    statement.run(value);
    statement.finalize();
}

function readRows(db) {
    // Read some data.
    
    db.each("select [rowid] as [id], [name] from [data]", (err, row) => {
        console.log(row.id + ": " + row.name);
    });
}

function fetchPage(url, callback) {
    // Use request to read in pages.
    
    request(url, (error, response, body) => {
        if (error) {
            console.log("Error requesting page: " + error);
            return;
        }
        callback(body);
    });
}

function run(db) {
    // Read the lodged applications page.
    
    fetchPage("https://www.campbelltown.sa.gov.au/page.aspx?u=1973", body => {
        // Use cheerio to find things in the page with css selectors.
        
        let $ = cheerio.load(body);
        let elements = $("div.uContentList a.href").each(() => {
            let pdfUrl = $(this).text().trim();
            let pdfPipe = request({url: pdfUrl, encoding: null}).pipe(pdf2json);
            pdfPipe.on("pdfParser_dataError", err => console.error(err));
            pdfPipe.on("pdfParser_dataReady", pdf => {
                // let pdf = pdfParser.getMergedTextBlocksIfNeeded();
                for (let page of pdf.formImage.Pages) {
                    // Parse text of PDF to extract development application details ...
                    // updateRow(db, value);
                }
                console.log("Parsed PDF " + pdfUrl + ".");
            });
        });
        readRows(db);
        db.close();
    });

    // Read the approved applications page.
        
    fetchPage("https://http://www.campbelltown.sa.gov.au/page.aspx?u=1777", body => {
        // Use cheerio to find things in the page with css selectors.
        
        let $ = cheerio.load(body);
        let elements = $("div.uContentList a.href").each(() => {
            let value = $(this).text().trim();
            updateRow(db, value);
        });
        readRows(db);
        db.close();
    });
}

initDatabase(run);
