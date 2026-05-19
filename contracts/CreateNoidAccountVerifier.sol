// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract CreateNoidAccountVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 20491192805390485299153009773594534940189261866228447918068658471970481763042;
    uint256 constant alphay  = 9383485363053290200918347156157836566562967994039712273449902621266178545958;
    uint256 constant betax1  = 4252822878758300859123897981450591353533073413197771768651442665752259397132;
    uint256 constant betax2  = 6375614351688725206403948262868962793625744043794305715222011528459656738731;
    uint256 constant betay1  = 21847035105528745403288232691147584728191162732299865338377159692350059136679;
    uint256 constant betay2  = 10505242626370262277552901082094356697409835680220590971873171140371331206856;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 11768548648270862754508869784894384634569724334745442424944613096818078930701;
    uint256 constant deltax2 = 20602540918806950139334194811896090288893302541532924146113292259443411140828;
    uint256 constant deltay1 = 6332299606991110532915493938595702959042663730923284335632292937349557092594;
    uint256 constant deltay2 = 193440379080175379395224254728266855787380882733650020673933540383067768808;

    
    uint256 constant IC0x = 15240718541140314165066994405890555183577363878524114076003608415623051552961;
    uint256 constant IC0y = 3015565876337567298290388867375079788802119980710896594776431781420099984906;
    
    uint256 constant IC1x = 11517680129568573377197914630168365586893162965752991768357359146345227903986;
    uint256 constant IC1y = 14701926011380905774477580378104382217985173377218475553223382612767190256319;
    
    uint256 constant IC2x = 6769541997670360341284327735241172176262389302093261315197155510594376484209;
    uint256 constant IC2y = 2186003693093697713041432399417170674176544627024379078991661093114666786462;
    
    uint256 constant IC3x = 15926878115736987875690765853836264883233221441390695104820840509271781852193;
    uint256 constant IC3y = 21040686101552460642279964449204497220781521812435223773913503612983305510260;
    
    uint256 constant IC4x = 13282321457066162317624671421682506431517266059343689419222261782510556136471;
    uint256 constant IC4y = 1858317513583442373146972258879181623169967472214237942390968320313049274374;
    
    uint256 constant IC5x = 20626448215448759583661923102075572419305967672511297210731659377878908743053;
    uint256 constant IC5y = 611726899538629108051777273972117766770483792353200523763125856620959615172;
    
    uint256 constant IC6x = 2695587639196878719285769953297306029165032208328588983605441187840565898678;
    uint256 constant IC6y = 11028701556797485852331198548027043683526357525459777650454557568613830617936;
    
    uint256 constant IC7x = 10067988924965463446205210732448373640103801545324152533741403206064042551636;
    uint256 constant IC7y = 16364341996032496704387452656540942358758740687509357077308353247988250257029;
    
    uint256 constant IC8x = 3904678365062249064573196224658597064596751144237523850291374146197014684920;
    uint256 constant IC8y = 8882534917306348487600298402647612185698119567645996463431059312619632933778;
    
    uint256 constant IC9x = 923246500090222019094747899026821934941002509402985460747332643106512130380;
    uint256 constant IC9y = 9729386224509468687695057848825851250769981822908715139222979473327096339866;
    
    uint256 constant IC10x = 17330345219302562081577176027074065435188658672077207261419066787903430527156;
    uint256 constant IC10y = 5353368895260696833784590296973633910746073050732348266844851798197698219540;
    
    uint256 constant IC11x = 11246071120440245400634181956103106053528995232951701384214285359019592788359;
    uint256 constant IC11y = 7558216237215446334250512602146119036058040674170466491288244124673344679195;
    
    uint256 constant IC12x = 12214821539646661175916765644363842552950467251767619379323449612977808637680;
    uint256 constant IC12y = 2118803759283506450112865689378854206432048005619012098730693513576300118383;
    
    uint256 constant IC13x = 9904942862500005815225220602926050112960008438738894396639874673184366665408;
    uint256 constant IC13y = 20692264312291206550648683878503688749370280722975776017269712735430137016503;
    
    uint256 constant IC14x = 11394896015134320252965454773798129590694155385198562921252782380738782291163;
    uint256 constant IC14y = 8925095654260602568124611463267786651893074345056276688983752821587742033311;
    
    uint256 constant IC15x = 19005907666756124449992777158924217450376919185841202790025817550652221870692;
    uint256 constant IC15y = 15714870855994595864706207334372935401818286220944931051631665983804156747086;
    
    uint256 constant IC16x = 21228494422345522213881724934724644019464551486456318987617161891865279306079;
    uint256 constant IC16y = 19771498309152223140679057803156523094341009241444144841828208117171047154771;
    
    uint256 constant IC17x = 9275096171601839300460690478305931696129252854654278409154894337808443324358;
    uint256 constant IC17y = 14694105239778574712855664521153870389918420069038340412678628400645144353444;
    
    uint256 constant IC18x = 19140117541107828038520309580422681752350777481146158902045569677450445148611;
    uint256 constant IC18y = 669546870472268174764816025294351393180191228079703551501228300437723740263;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[18] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
